import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveGoldenRulePriorityOrder, resolveVision } from '@agent/core/vision-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import type { GoldenRulePriority } from '@agent/core/vision-resolver';
import { nowIso } from '@agent/core/foundation';
import {
  readWisdomJsonObject,
  readWisdomRecordArray,
  readWisdomString,
  readWisdomStringArray,
  type WisdomJsonObject,
} from './wisdom-persisted-json.js';

function readResolvedPath(rel: string): string {
  return safeReadFile(assertSafeRepositoryPath(pathResolver.rootResolve(rel)), {
    encoding: 'utf8',
  }) as string;
}

function readJSON(rel: string): WisdomJsonObject {
  return readWisdomJsonObject(rel);
}

function writeJSON(rel: string, data: any): string {
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(rel), { allowMissingLeaf: true });
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(abs, JSON.stringify(data, null, 2));
  return rel;
}

function generateHeuristicId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HEU-${time}-${rand}`;
}

export interface CaptureIntuitionInput {
  decision: string;
  anchor: string;
  analogy: string;
  vetoed_options?: string[];
  mission_id?: string;
  trigger?: 'five_second_rule' | 'explicit_gut_flag' | 'tonal_detection';
  tags?: string[];
}

export function captureIntuition(input: CaptureIntuitionInput): {
  id: string;
  written_to: string;
} {
  if (!input.decision || !input.anchor || !input.analogy) {
    throw new Error(
      '[capture_intuition] requires decision, anchor, and analogy (the three Intuition Capture answers)'
    );
  }
  const id = generateHeuristicId();
  const entry: Record<string, unknown> = {
    id,
    captured_at: nowIso(),
    decision: input.decision,
    anchor: input.anchor,
    analogy: input.analogy,
  };
  if (input.vetoed_options && input.vetoed_options.length > 0) {
    entry.vetoed_options = input.vetoed_options;
  }
  if (input.mission_id) entry.mission_id = input.mission_id;
  if (input.trigger) entry.trigger = input.trigger;
  if (input.tags && input.tags.length > 0) entry.tags = input.tags;

  const relPath = `knowledge/confidential/heuristics/${id}.json`;
  writeJSON(relPath, entry);
  return { id, written_to: relPath };
}

// NOTE: LLM/voice-dependent ops now delegate to reasoning-backend / voice-bridge.
// The backends are responsible for their own provenance signalling (engine_id,
// _synthetic, warn logs when unregistered).

// ---------------------------------------------------------------------------
// Pure-logic ops
// ---------------------------------------------------------------------------

/**
 * Emit dissent log from a hypothesis tree or arbitrary source with {hypotheses}.
 * Filters hypotheses with `status === 'rejected'` (or falsy `survived`) and
 * writes a schema-conformant dissent-log.json.
 */
export function emitDissentLog(input: {
  source_path: string;
  output_path: string;
  append?: boolean;
  mission_id?: string;
  topic?: string;
}): { written_to: string; count: number } {
  const src = readJSON(input.source_path);
  const pool = readWisdomRecordArray(src, ['hypotheses', 'items'], 'source');

  const rejected = pool.filter((h) => {
    if (typeof h.status === 'string') return h.status === 'rejected';
    if (typeof h.survived === 'boolean') return !h.survived;
    return false;
  });

  const dissents = rejected.map((h) => ({
    hypothesis:
      readWisdomString(h, 'content', '', 'hypothesis') ||
      readWisdomString(h, 'hypothesis', '', 'hypothesis') ||
      readWisdomString(h, 'summary', JSON.stringify(h), 'hypothesis'),
    proposed_by:
      readWisdomString(h, 'proposed_by', '', 'hypothesis') ||
      readWisdomString(h, 'persona', 'unknown', 'hypothesis'),
    rejection_reason:
      readWisdomString(h, 'rejection_reason', '', 'hypothesis') ||
      readWisdomString(h, 'critique', 'not-provided', 'hypothesis'),
    rejection_confidence: readWisdomString(h, 'rejection_confidence', 'medium', 'hypothesis'),
    revisit_triggers: readWisdomStringArray(h, 'revisit_triggers', 'hypothesis'),
    evidence_refs: readWisdomStringArray(h, 'evidence_refs', 'hypothesis'),
  }));

  let existing: WisdomJsonObject | null = null;
  const outputPath = assertSafeRepositoryPath(pathResolver.rootResolve(input.output_path), {
    allowMissingLeaf: true,
  });
  if (input.append && safeExistsSync(outputPath)) {
    existing = readJSON(input.output_path);
    readWisdomRecordArray(existing, ['dissents'], 'existing dissent log');
  }

  const payload = existing
    ? {
        ...existing,
        dissents: [
          ...readWisdomRecordArray(existing, ['dissents'], 'existing dissent log'),
          ...dissents,
        ],
      }
    : {
        mission_id: input.mission_id || readWisdomString(src, 'mission_id', 'unknown', 'source'),
        topic: input.topic || readWisdomString(src, 'topic', 'unspecified', 'source'),
        dissents,
        created_at: nowIso(),
      };

  writeJSON(input.output_path, payload);
  return { written_to: input.output_path, count: dissents.length };
}

/**
 * Render hypothesis-tree.json (post cross-critique) as a human-readable
 * Markdown report. Groups by proposed_by persona, shows critiques + status,
 * and emits a final summary of survived vs rejected counts.
 */
export function renderHypothesisReport(input: {
  source_path: string;
  output_path: string;
  title?: string;
}): { written_to: string; sections: number } {
  const src = readJSON(input.source_path);
  const topic = readWisdomString(src, 'topic', '', 'source');
  const hypotheses = readWisdomRecordArray(src, ['hypotheses'], 'source');
  const generatedBy = readWisdomString(src, 'generated_by', 'unknown', 'source');
  const generatedAt = readWisdomString(src, 'generated_at', '', 'source');

  const byPersona = new Map<string, any[]>();
  for (const h of hypotheses) {
    const key = readWisdomString(h, 'proposed_by', 'unknown', 'hypothesis');
    if (!byPersona.has(key)) byPersona.set(key, []);
    byPersona.get(key)!.push(h);
  }

  const survivedCount = hypotheses.filter((h) => h.survived === true).length;
  const rejectedCount = hypotheses.filter((h) => h.survived === false).length;
  const pendingCount = hypotheses.length - survivedCount - rejectedCount;

  const lines: string[] = [];
  lines.push(`# ${input.title || 'Hypothesis Tree Report'}`);
  lines.push('');
  lines.push(`**Topic**: ${topic}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Generated by: \`${generatedBy}\``);
  if (generatedAt) lines.push(`- Generated at: ${generatedAt}`);
  lines.push(`- Personas: ${byPersona.size}`);
  lines.push(`- Total hypotheses: ${hypotheses.length}`);
  lines.push(
    `- Survived: ${survivedCount} / Rejected: ${rejectedCount} / Pending: ${pendingCount}`
  );
  lines.push('');

  lines.push('## Hypotheses by persona');
  lines.push('');
  const personaEntries = Array.from(byPersona.entries());
  for (const [persona, items] of personaEntries) {
    lines.push(`### ${persona}`);
    lines.push('');
    for (const h of items) {
      const statusEmoji = h.survived === true ? '✅' : h.survived === false ? '❌' : '⏳';
      lines.push(`#### ${statusEmoji} ${readWisdomString(h, 'id', '(no-id)', 'hypothesis')}`);
      lines.push('');
      lines.push(readWisdomString(h, 'content', '(no content)', 'hypothesis'));
      lines.push('');
      if (h.survived === false && typeof h.rejection_reason === 'string') {
        lines.push(`> **Rejected because**: ${h.rejection_reason}`);
        lines.push('');
      }
      const critiques = readWisdomRecordArray(
        h,
        ['critiques'],
        `hypothesis ${readWisdomString(h, 'id', '(no-id)', 'hypothesis')}`
      );
      if (critiques.length > 0) {
        lines.push('**Critiques:**');
        lines.push('');
        for (const c of critiques) {
          lines.push(
            `- *by ${readWisdomString(c, 'by', 'unknown', 'critique')}*: ${readWisdomString(c, 'content', '', 'critique')}`
          );
        }
        lines.push('');
      }
    }
  }

  lines.push('## Summary');
  lines.push('');
  if (survivedCount > 0) {
    lines.push(
      `${survivedCount} hypothes${survivedCount === 1 ? 'is' : 'es'} survived cross-critique and warrant further investigation.`
    );
  }
  if (rejectedCount > 0) {
    lines.push(
      `${rejectedCount} hypothes${rejectedCount === 1 ? 'is was' : 'es were'} rejected — see \`dissent-log.json\` for revisit triggers.`
    );
  }
  if (pendingCount > 0) {
    lines.push(
      `${pendingCount} hypothes${pendingCount === 1 ? 'is remains' : 'es remain'} pending (no critique pass yet).`
    );
  }
  lines.push('');

  const outputPath = assertSafeRepositoryPath(pathResolver.rootResolve(input.output_path), {
    allowMissingLeaf: true,
  });
  safeMkdir(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, lines.join('\n'));
  return { written_to: input.output_path, sections: personaEntries.length };
}

/**
 * CO-04 Task 3: when hypothesis-tree convergence (hypothesis-tree-protocol.md
 * Phase C) leaves more than one hypothesis surviving critique, decide between
 * them deterministically using the vision's golden-rule priority order
 * (Logical Integrity > Vision Alignment > Execution Speed > Adaptive
 * Resilience by default) instead of an arbitrary pick. A candidate without a
 * declared golden_rule_dimension ranks last — omission must not win a
 * tie-break by default.
 */
export function resolveHypothesisConflict(input: {
  source_path: string;
  tenant_slug?: string | null;
  output_path: string;
}): {
  winner_id: string | null;
  conflict: boolean;
  survivor_count: number;
  golden_rule_priority: GoldenRulePriority[];
  written_to: string;
} {
  const src = readJSON(input.source_path);
  const hypotheses = readWisdomRecordArray(src, ['hypotheses'], 'source');
  const survivors = hypotheses.filter((h) => h.survived === true);

  const priority = resolveGoldenRulePriorityOrder(resolveVision(input.tenant_slug ?? null));
  const dimensionRank = (h: any): number => {
    const dimension = typeof h.golden_rule_dimension === 'string' ? h.golden_rule_dimension : null;
    const idx = dimension ? priority.indexOf(dimension as GoldenRulePriority) : -1;
    return idx === -1 ? priority.length : idx;
  };

  const conflict = survivors.length > 1;
  const winner = conflict
    ? [...survivors].sort((a, b) => dimensionRank(a) - dimensionRank(b))[0]
    : (survivors[0] ?? null);

  const result = {
    winner_id: typeof winner?.id === 'string' ? winner.id : null,
    conflict,
    survivor_count: survivors.length,
    golden_rule_priority: priority,
    resolved_at: nowIso(),
  };
  writeJSON(input.output_path, result);
  return { ...result, written_to: input.output_path };
}

/**
 * Append-only proposal adjustment. Records new signals as a trailing
 * "Updates" section on the proposal file. Semantic rewording requires an LLM
 * and is not attempted here.
 */
export function adjustProposalAppend(input: {
  proposal_path: string;
  signals: any;
  output_path?: string;
}): { written_to: string } {
  const original = readResolvedPath(input.proposal_path);
  const block = `\n\n---\n### Updates (${nowIso()})\n\n\`\`\`json\n${JSON.stringify(input.signals, null, 2)}\n\`\`\`\n`;
  const out = input.output_path || input.proposal_path;
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(out), { allowMissingLeaf: true });
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, original + block);
  return { written_to: out };
}
