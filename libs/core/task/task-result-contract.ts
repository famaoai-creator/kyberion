import {
  TaskCustomerDecisionRequestSchema,
  TaskResultSchema,
  formatZodIssues,
} from '../structured-output-contracts.js';
import type { TaskResultBlock } from '../surface/channel-surface-types.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { replaceFencedBlocks } from '../foundation/text.js';
import { createLogger } from '../logger.js';

const logger = createLogger('task-result-contract');

export interface TaskResultValidationResult {
  valid: boolean;
  errors: string[];
  value?: TaskResultBlock;
}

export interface TaskResultRepairResult {
  value?: TaskResultBlock;
  repairs: string[];
  requiresReview: boolean;
}

export function validateTaskResult(value: unknown): TaskResultValidationResult {
  const result = TaskResultSchema.safeParse(value);
  return {
    valid: result.success,
    errors: result.success ? [] : formatZodIssues(result.error),
    value: result.success ? result.data : undefined,
  };
}

/** Apply only conservative repairs; never turn uncertain evidence into a pass. */
export function repairTaskResult(value: unknown): TaskResultRepairResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { repairs: [], requiresReview: false };
  }

  const candidate = { ...(value as Record<string, unknown>) };
  const repairs: string[] = [];
  let requiresReview = false;
  if (typeof candidate.summary === 'string' && candidate.summary.length > 800) {
    candidate.summary = `${candidate.summary.slice(0, 797).trimEnd()}...`;
    repairs.push('summary truncated to the 800-character contract limit');
  }
  if (Array.isArray(candidate.acceptance_evidence)) {
    candidate.acceptance_evidence = candidate.acceptance_evidence.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const current = entry as Record<string, unknown>;
      if (current.status === 'passed' || current.status === 'failed') return entry;
      repairs.push('semantic: invalid acceptance_evidence status normalized to failed');
      requiresReview = true;
      return { ...current, status: 'failed' };
    });
  }
  // CD-09: a malformed customer-judgment question is dropped (never the whole
  // result). The warning carries counts only — the entries may hold customer data.
  if ('customer_decisions' in candidate) {
    const entries = Array.isArray(candidate.customer_decisions) ? candidate.customer_decisions : [];
    const kept = entries
      .slice(0, 20)
      .filter((entry) => TaskCustomerDecisionRequestSchema.safeParse(entry).success);
    const dropped = Array.isArray(candidate.customer_decisions)
      ? candidate.customer_decisions.length - kept.length
      : 1;
    if (dropped > 0) {
      logger.warn(
        `task_result customer_decisions: ${dropped} invalid entr${dropped === 1 ? 'y' : 'ies'} dropped — not a valid customer decision request | the task goes on without forwarding them; return question, item, key, requires_customer and proposed_value | kept=${kept.length}`
      );
      repairs.push(`customer_decisions: ${dropped} invalid entries dropped`);
    }
    if (kept.length > 0) candidate.customer_decisions = kept;
    else delete candidate.customer_decisions;
  }
  const validation = validateTaskResult(candidate);
  return validation.valid && validation.value
    ? { value: validation.value, repairs, requiresReview }
    : { repairs, requiresReview };
}

export function extractTaskResultBlocks(raw: string): {
  text: string;
  taskResults: TaskResultBlock[];
  taskResultErrors: string[];
  taskResultRepairs: string[];
  taskResultRepairRequiresReview: boolean;
} {
  const taskResults: TaskResultBlock[] = [];
  const taskResultErrors: string[] = [];
  const taskResultRepairs: string[] = [];
  let taskResultRepairRequiresReview = false;
  let text = raw;

  text = replaceFencedBlocks(text, (lang, content, block) => {
    if (lang.toLowerCase() !== 'task_result') return block;
    const json = content;
    const trimmed = String(json).trim();
    if (!trimmed) {
      taskResultErrors.push('task_result block was empty');
      return '';
    }

    try {
      const parsed = parseSafeJsonInput(trimmed, 'task_result block');
      const validation = validateTaskResult(parsed);
      if (validation.valid && validation.value) {
        taskResults.push(validation.value);
      } else {
        const repaired = repairTaskResult(parsed);
        if (repaired.value) {
          taskResults.push(repaired.value);
          taskResultRepairs.push(...repaired.repairs);
          taskResultRepairRequiresReview ||= repaired.requiresReview;
        } else {
          taskResultErrors.push(`task_result validation failed: ${validation.errors.join('; ')}`);
        }
      }
    } catch (error: any) {
      taskResultErrors.push(`task_result JSON parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  return {
    text,
    taskResults,
    taskResultErrors,
    taskResultRepairs,
    taskResultRepairRequiresReview,
  };
}

const CUSTOMER_DECISIONS_MARK = 'customer_decisions';

/**
 * CD-09: a worker reply as it may be quoted back in a prompt (the task-result
 * retry excerpt is recorded as mission-visible, public by default): every
 * `customer_decisions` field is taken out of the task_result blocks, a block
 * that cannot be parsed but mentions them is replaced, and a reply that still
 * mentions them outside a block is not quoted at all (empty string).
 */
export function redactCustomerDecisionsForPrompt(raw: string): string {
  let omitted = 0;
  const text = replaceFencedBlocks(raw, (lang, content, block) => {
    if (lang.toLowerCase() !== 'task_result') return block;
    // Parse first: an escaped key (`\u0063ustomer_decisions`) is still the field.
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(content.trim(), 'task_result block');
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, CUSTOMER_DECISIONS_MARK)) {
        if (!content.includes(CUSTOMER_DECISIONS_MARK)) return block;
        // The mark appears only inside a value: quote the parsed form, not the raw text.
        const rendered = JSON.stringify(parsed);
        if (!rendered.includes(CUSTOMER_DECISIONS_MARK)) {
          return ['```task_result', rendered, '```'].join('\n');
        }
      } else {
        const { customer_decisions: decisions, ...rest } = parsed as Record<string, unknown>;
        omitted += Array.isArray(decisions) ? decisions.length : 1;
        const rendered = JSON.stringify(rest);
        if (!rendered.includes(CUSTOMER_DECISIONS_MARK)) {
          return ['```task_result', rendered, '```'].join('\n');
        }
        omitted -= Array.isArray(decisions) ? decisions.length : 1;
      }
    } else if (!content.includes(CUSTOMER_DECISIONS_MARK) && !/\\u00/u.test(content)) {
      // Unparseable and plainly free of the field: quoted as-is (the retry repairs it).
      return block;
    }
    omitted += 1;
    return '```task_result\n[omitted: the block carried customer_decisions]\n```';
  });
  if (text.includes(CUSTOMER_DECISIONS_MARK)) return '';
  return omitted > 0
    ? `${text}\n(customer decisions omitted from this excerpt: ${omitted}; return them again if they still apply)`
    : text;
}

/**
 * CD-09: a worker reply as it is consumed or stored on a path that has no
 * customer decision case (WorkItem dispatch, the coordinated execution
 * port's WorkItem record). Unlike the prompt redactor it never blanks the
 * reply: each parseable task_result block loses only its `customer_decisions`
 * field (the rest is re-serialized, a summary that merely mentions the word
 * stays), prose is kept as-is, and only an unparseable task_result block that
 * looks like it carries the field is replaced (it would not parse either way).
 */
export function stripCustomerDecisionsFromReply(raw: string): string {
  return replaceFencedBlocks(raw, (lang, content, block) => {
    if (lang.toLowerCase() !== 'task_result') return block;
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(content.trim(), 'task_result block');
    } catch {
      return content.includes(CUSTOMER_DECISIONS_MARK) || /\\u00/u.test(content)
        ? '```task_result\n[omitted: an unparseable block that may carry customer_decisions]\n```'
        : block;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.prototype.hasOwnProperty.call(parsed, CUSTOMER_DECISIONS_MARK)
    )
      return block;
    const { customer_decisions: _decisions, ...rest } = parsed as Record<string, unknown>;
    void _decisions;
    return ['```task_result', JSON.stringify(rest), '```'].join('\n');
  });
}
