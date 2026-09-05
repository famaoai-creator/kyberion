/**
 * ADF Repair Agent — Uses an autonomous sub-agent to fix schema or logical errors in ADF files.
 *
 * Repair cascade (cheapest first):
 *   1. Lightweight structural JSON repair (json-repair.ts) — no LLM, instant
 *   2. Targeted schema-aware repair hint — LLM sub-agent with full schema + classified error hints
 */

import { getReasoningBackend, type ReasoningCallOptions } from './reasoning-backend.js';
import * as path from 'node:path';
import { assertSafeRepositoryPath, safeLstat, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';
import { validate, loadSchema } from './validate.js';
import { pathResolver } from './path-resolver.js';
import { tryRepairJson, repairJsonString } from './json-repair.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import {
  completeDelegatedTaskTrace,
  startDelegatedTaskTrace,
} from './delegated-task-observability.js';
import { createGapRecorder } from './gap-phase.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import { recordKnowledgeDelivery } from './src/knowledge-feedback-loop.js';
import { isLocalReasoningBackend } from './reasoning-egress-scope.js';
import {
  checkProviderEgress,
  highestTierForPaths,
  providerIdForReasoningIdentifier,
} from './provider-egress-gate.js';
import { delegateWorkItemWithReasoningBackend } from './reasoning-backend-execution-adapter.js';
import { getWorkItem } from './work-coordination.js';
import { isValidTenantSlug } from './entity-scope.js';
import { readTextFile, truncateNormalizedText } from './foundation/text.js';
import { assertProjectTrustApproval } from './project-trust.js';
import { isBuiltinPipelineResource } from './trust-requiring-resources.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/primitives.js';
import type { ValidationResult } from './types.js';

export interface AdfRepairResult {
  repaired: boolean;
  errors?: string[];
  report?: string;
}

export interface AdfRepairStep {
  op: string;
  id?: string;
  params?: unknown;
}

export interface AdfRepairFailure {
  category: string;
  detail?: string;
  repairAction?: string;
}
export interface AdfRepairOptions {
  workItemId?: string;
  /** Explicit project-trust decision for pipeline ADF mutation. */
  trustResolved?: boolean;
  /** Durable human approval for the exact project-local pipeline ADF. */
  projectTrustApprovalId?: string;
  /** Explicit step failure context for the canonical execution repair path. */
  step?: AdfRepairStep;
  failure?: AdfRepairFailure;
  delegationOptions?: ReasoningCallOptions;
}

function resolveAdfRepairPath(adfPath: string): string {
  return assertSafeRepositoryPath(path.resolve(pathResolver.rootResolve(adfPath)));
}

function assertAdfRepairFile(filePath: string): void {
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[ADF_REPAIR] repair target must be a regular file: ${filePath}`);
  }
}

function assertPipelineRepairTrust(adfPath: string, options: AdfRepairOptions): void {
  const absolute = resolveAdfRepairPath(adfPath);
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[TRUST_REQUIRED] ADF repair target must stay inside the repository: ${adfPath}`
    );
  }
  if (options.projectTrustApprovalId) {
    assertProjectTrustApproval(options.projectTrustApprovalId, absolute);
    return;
  }
  if (isBuiltinPipelineResource(relative) || options.trustResolved === true) return;
  throw new Error(
    `[TRUST_REQUIRED] project-local pipeline ADF repair requires an explicit project-trust decision: ${relative}`
  );
}

/**
 * Validates an ADF file against its schema and attempts autonomous repair if it fails.
 * @param adfPath Path to the ADF file.
 * @param schemaName Name of the schema (without extension).
 */
export async function validateAndRepairAdf(
  adfPath: string,
  schemaName: string,
  options: AdfRepairOptions = {}
): Promise<AdfRepairResult> {
  const repairPath = resolveAdfRepairPath(adfPath);
  if (schemaName === 'pipeline-adf') assertPipelineRepairTrust(repairPath, options);
  assertAdfRepairFile(repairPath);
  const content = readTextFile(repairPath);
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(content, 'ADF input');
  } catch (err: unknown) {
    // 1. Try lightweight structural repair before escalating to the LLM subagent
    const lightweight = tryRepairJson(content);
    if (lightweight !== null) {
      const repairedStr = repairJsonString(content)!;
      logger.info(
        `[adf-repair] Lightweight JSON repair succeeded for ${repairPath} — skipping subagent delegation`
      );
      assertAdfRepairFile(repairPath);
      safeWriteFile(repairPath, repairedStr, { encoding: 'utf8' });
      parsed = lightweight;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[adf-repair] Failed to parse JSON at ${repairPath}: ${message}`);
      return attemptSubagentRepair(
        repairPath,
        schemaName,
        `JSON parse error: ${message}`,
        [],
        options
      );
    }
  }

  if (schemaName === 'pipeline-adf') {
    if (options.failure) {
      const stepLabel = options.step?.op ? ` for step ${options.step.op}` : '';
      const details = [options.failure.detail, options.failure.repairAction].filter(Boolean);
      return attemptSubagentRepair(
        repairPath,
        schemaName,
        `Execution failure${stepLabel}: ${options.failure.category}`,
        details,
        options
      );
    }
    try {
      const pipeline = validatePipelineAdf(parsed);
      const guardrails = validatePipelineGuardrails(pipeline, repairPath);
      if (!guardrails.ok) {
        const errors = guardrails.findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => `${finding.path}: ${finding.message}`);
        logger.warn(
          `[adf-repair] Guardrail validation failed for ${repairPath}. Errors: ${errors.length}.`
        );
        return {
          repaired: false,
          errors,
          report: `ADF guardrails failed: ${errors.join('; ')}`,
        };
      }
      return { repaired: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return attemptSubagentRepair(repairPath, schemaName, '', [message], options);
    }
  }

  // 2. Schema validation
  const validation = isRecord(parsed)
    ? validate(parsed, schemaName)
    : {
        valid: false,
        errors: [{ field: '$', message: 'ADF root must be a JSON object' }],
      };
  if (validation.valid) {
    return { repaired: false };
  }

  logger.warn(
    `[adf-repair] Schema validation failed for ${repairPath}. Errors: ${validation.errors.length}. Delegating to sub-agent...`
  );
  return attemptSubagentRepair(
    repairPath,
    schemaName,
    '',
    validation.errors.map((e) => `${e.field}: ${e.message}`),
    options
  );
}

const ADF_REPAIR_KNOWLEDGE_HINT_LIMIT = 2;
const ADF_REPAIR_KNOWLEDGE_EXCERPT_MAX = 200;

function validateRepairTarget(
  value: unknown,
  schemaName: string,
  adfPath: string
): ValidationResult {
  if (schemaName !== 'pipeline-adf') {
    if (!isRecord(value)) {
      return {
        valid: false,
        errors: [{ field: '$', message: 'ADF root must be a JSON object' }],
      };
    }
    return validate(value, schemaName);
  }
  try {
    const pipeline = validatePipelineAdf(value);
    const guardrails = validatePipelineGuardrails(pipeline, adfPath);
    if (guardrails.ok) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: guardrails.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => ({ field: finding.path, message: finding.message })),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          field: 'pipeline',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/**
 * KP-02: enrich the repair delegation's context with knowledge hints for
 * this schema/error topic.
 *
 * (a) The failing op's own contract/schema doc is already resolved by the
 * caller as `schemaContent` (via `loadSchema`/`readTextFile` against the
 * real `${schemaName}.schema.json` or the pipeline-adf schema file) and
 * embedded directly in `instruction`'s "## Expected Schema" section — that
 * is the repair agent's existing ground truth for the op, so there is
 * nothing left for this helper to resolve there.
 * (b) This adds top `findRelevantDistilledKnowledge` hits for the schema
 * name + error/hint text (e.g. prior incident write-ups about the same kind
 * of schema violation), mirroring the excerpt/truncation conventions from
 * task-knowledge-provisioning.ts (200-char excerpts).
 *
 * `provisionTaskKnowledge` is not used here for the same reason as
 * background-review-runner.ts: ADF repair delegation has no `missionId` to
 * resolve a mission context pack around — it operates on a bare ADF file
 * path outside any mission — so this calls the lower-level primitive
 * directly and records delivery with a non-mission scope marker.
 *
 * Fail-open: any lookup error is swallowed and logged once; delegation
 * proceeds with the original `ADF Repair: <path>` context label exactly as
 * before this change.
 *
 * XP-03: no mission tier exists at this call site either (bare ADF path,
 * no mission). Tier is derived from the delivered hint paths
 * (`highestTierForPaths`) and the provider from the reasoning backend
 * actually handling this repair (`backendName`). A denial drops the
 * knowledge section and falls back to `baseContext`, same fail-open shape
 * as the catch below.
 */
async function buildAdfRepairKnowledgeContext(
  adfPath: string,
  schemaName: string,
  errorSummary: string,
  hints: string,
  backendName: string
): Promise<string> {
  const baseContext = `ADF Repair: ${adfPath}`;
  try {
    const topic = [schemaName, errorSummary, hints].filter(Boolean).join(' ').slice(0, 2_000);
    if (!topic.trim()) return baseContext;
    const entries = await findRelevantDistilledKnowledge({
      topic,
      tags: [schemaName],
      limit: ADF_REPAIR_KNOWLEDGE_HINT_LIMIT,
      minScore: 0.08,
    });
    if (entries.length === 0) return baseContext;

    if (!isLocalReasoningBackend(backendName)) {
      const providerId = providerIdForReasoningIdentifier(backendName);
      if (providerId) {
        const dataTier = highestTierForPaths(entries.map((entry) => entry.path));
        const egressCheck = checkProviderEgress({ provider: providerId, dataTier });
        if (!egressCheck.allowed) {
          logger.warn(
            `[KP-02][XP-03] ADF repair knowledge egress denied for provider=${providerId} tier=${dataTier}: ${egressCheck.reason}`
          );
          return baseContext;
        }
      }
    }

    const lines = [
      'Relevant knowledge:',
      ...entries.map(
        (entry) =>
          `- ${entry.title} (${entry.path}): ${truncateNormalizedText(entry.excerpt, ADF_REPAIR_KNOWLEDGE_EXCERPT_MAX)}`
      ),
    ];
    recordKnowledgeDelivery({
      missionId: `adf-repair:${schemaName}`,
      taskId: adfPath,
      recipientKind: 'adf_repair_agent',
      refs: entries.map((entry) => ({ path: entry.path, score: entry.score, title: entry.title })),
    });
    return `${baseContext}\n\n${lines.join('\n')}`;
  } catch (error) {
    logger.warn(
      `[KP-02] ADF repair knowledge lookup failed, delegating without knowledge context: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return baseContext;
  }
}

async function attemptSubagentRepair(
  adfPath: string,
  schemaName: string,
  parseError: string,
  validationErrors: string[],
  options: AdfRepairOptions = {}
): Promise<AdfRepairResult> {
  const backend = getReasoningBackend();
  const errorSummary = parseError || validationErrors.join('; ');

  const trace = startDelegatedTaskTrace({
    owner: 'adf-repair-agent',
    instruction: `Repair invalid ADF at ${adfPath} against ${schemaName}.schema.json`,
    context: errorSummary,
    contextRef: adfPath,
    backendName: backend.name,
  });

  // Load the actual schema so the LLM has ground truth, not just error messages
  let schemaContent = '(schema not available)';
  try {
    if (schemaName === 'pipeline-adf') {
      schemaContent = readTextFile(
        pathResolver.knowledge('product/schemas/pipeline-adf.schema.json')
      );
    } else {
      schemaContent = JSON.stringify(loadSchema(schemaName), null, 2);
    }
  } catch {
    /* non-fatal — proceed without it */
  }

  // Classify errors to generate targeted repair hints
  const hints = buildRepairHints(validationErrors, parseError);

  const instruction = `
The ADF file at '${adfPath}' is invalid and must be repaired.

${options.step ? `## Failed Step\nOperation: ${options.step.op}\nStep ID: ${options.step.id || '(none)'}\nParams: ${JSON.stringify(options.step.params ?? {})}\n` : ''}

## Errors
${parseError ? `JSON Parse Error: ${parseError}\n` : ''}${validationErrors.length > 0 ? validationErrors.map((e) => `- ${e}`).join('\n') : ''}

## Repair Hints
${hints}

## Expected Schema (${schemaName}.schema.json)
\`\`\`json
${schemaContent}
\`\`\`

## Instructions
1. Read the current file at '${adfPath}'.
2. Fix ONLY the errors listed above. Do not change the intent of the file.
3. Ensure the result is valid JSON that satisfies the schema above.
4. Write the repaired content back to '${adfPath}'.

Output constraints: pure JSON, no markdown fences, no comments, no trailing commas.
`.trim();

  const gaps = createGapRecorder();
  try {
    assertAdfRepairFile(adfPath);
    const originalContent = readTextFile(adfPath);
    const repairContext = await gaps.measure('knowledge_slice', () =>
      buildAdfRepairKnowledgeContext(adfPath, schemaName, errorSummary, hints, backend.name)
    );
    const report = await gaps.measure('backend_dispatch', async () => {
      if (!options.workItemId) {
        return backend.delegateTask(instruction, repairContext, options.delegationOptions);
      }
      const workItem = getWorkItem(options.workItemId);
      const scope = workItem?.context;
      const tenantId = scope?.tenant_slug?.trim();
      if (!tenantId || !isValidTenantSlug(tenantId)) {
        throw new Error(`adf_repair_requires_valid_tenant_scope:${String(tenantId || '')}`);
      }
      const receipt = await delegateWorkItemWithReasoningBackend(backend, {
        work_item_id: options.workItemId,
        task_id: options.workItemId,
        instruction,
        security_scope: {
          tenant_id: tenantId,
          organization_id: scope?.organization_id,
          project_id: scope?.project_id,
          mission_id: scope?.mission_id || options.workItemId,
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'adf repair',
        },
        context_refs: [repairContext],
        success_status: 'done',
        idempotency_key: `adf-repair:${options.workItemId}:${adfPath}`,
      });
      return receipt.output || '';
    });
    logger.success(`[adf-repair] Sub-agent repair completed for ${adfPath}.`);

    // Re-verify after repair
    assertAdfRepairFile(adfPath);
    let updatedContent = readTextFile(adfPath);
    if (updatedContent === originalContent) {
      const returnedRepair = tryRepairJson(report);
      if (returnedRepair !== null) {
        const returnedValidation = validateRepairTarget(returnedRepair, schemaName, adfPath);
        if (returnedValidation.valid) {
          const repairedStr = repairJsonString(report)!;
          assertAdfRepairFile(adfPath);
          safeWriteFile(adfPath, repairedStr, { encoding: 'utf8' });
          updatedContent = repairedStr;
        }
      }
    }
    let updatedParsed: unknown;
    try {
      updatedParsed = parseSafeJsonInput(updatedContent, 'ADF repair output');
    } catch {
      // Last-chance repair on what the sub-agent wrote
      const recovered = tryRepairJson(updatedContent);
      if (recovered !== null) {
        assertAdfRepairFile(adfPath);
        safeWriteFile(adfPath, repairJsonString(updatedContent)!, { encoding: 'utf8' });
        updatedParsed = recovered;
      } else {
        completeDelegatedTaskTrace(trace, {
          error: 'sub-agent output is still unparseable JSON',
          gapPhases: gaps.samples(),
        });
        return { repaired: false, errors: ['sub-agent output is still unparseable JSON'], report };
      }
    }

    const finalValidation = validateRepairTarget(updatedParsed, schemaName, adfPath);
    if (finalValidation.valid) {
      completeDelegatedTaskTrace(trace, { resultSummary: report, gapPhases: gaps.samples() });
      return { repaired: true, report };
    }

    const finalErrors = finalValidation.errors.map((e) => `${e.field}: ${e.message}`);
    completeDelegatedTaskTrace(trace, {
      resultSummary: `repair completed but validation still failed: ${finalErrors.join('; ')}`,
      gapPhases: gaps.samples(),
    });
    return {
      repaired: false,
      errors: finalErrors,
      report: `Sub-agent attempted repair but file is still invalid: ${finalErrors.join('; ')}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    completeDelegatedTaskTrace(trace, {
      error: message,
      gapPhases: gaps.samples(),
    });
    return {
      repaired: false,
      errors: [message],
      report: `Sub-agent repair failed: ${message}`,
    };
  }
}

/** Classify validation errors and generate targeted repair hints. */
function buildRepairHints(validationErrors: string[], parseError: string): string {
  if (parseError) {
    return [
      '- The file is not valid JSON. Common causes: trailing commas, single quotes, markdown code fences,',
      '  unquoted object keys, or a truncated/incomplete file.',
      '- Strip any surrounding prose or ``` fences. The file must contain only a JSON object or array.',
    ].join('\n');
  }

  const hints: string[] = [];
  const missing = validationErrors.filter(
    (e) => e.includes('Required field') && e.includes('missing')
  );
  const typeMismatch = validationErrors.filter((e) => e.includes('Expected type'));
  const enumViolation = validationErrors.filter((e) => e.includes('not in allowed values'));
  const anyOfFail = validationErrors.filter((e) => e.includes('anyOf'));
  const other = validationErrors.filter(
    (e) =>
      !missing.includes(e) &&
      !typeMismatch.includes(e) &&
      !enumViolation.includes(e) &&
      !anyOfFail.includes(e)
  );

  if (missing.length > 0) {
    const fields = missing
      .map((e) => e.replace('Required field "', '').replace('" is missing', ''))
      .join(', ');
    hints.push(
      `- MISSING REQUIRED FIELDS: Add ${fields}. Check the schema for their expected types and structure.`
    );
  }
  if (typeMismatch.length > 0) {
    hints.push(
      `- TYPE MISMATCH: ${typeMismatch.map((e) => e.split(': ')[1]).join('; ')}. Ensure values match the declared JSON type (string/number/boolean/array/object).`
    );
  }
  if (enumViolation.length > 0) {
    hints.push(
      `- ENUM VIOLATION: ${enumViolation.map((e) => e.split(': ')[1]).join('; ')}. Replace with one of the allowed values listed in the error.`
    );
  }
  if (anyOfFail.length > 0) {
    hints.push(
      `- ALTERNATIVE REQUIRED FIELDS: The schema requires at least one of several field sets. Check the schema's anyOf block and supply one complete set.`
    );
  }
  if (other.length > 0) {
    hints.push(`- OTHER: ${other.join('; ')}`);
  }

  return hints.length > 0
    ? hints.join('\n')
    : '- Review the schema carefully and fix all structural/type mismatches.';
}
