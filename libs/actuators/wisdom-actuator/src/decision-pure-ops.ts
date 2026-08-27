import * as path from 'node:path';
import {
  pathResolver,
  resolveGoldenRulePriorityOrder,
  resolveVision,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  type GoldenRulePriority,
} from '@agent/core';
import { nowIso, readJson as readFoundationJson } from '@agent/core/foundation';

function readResolvedPath(rel: string): string {
  return safeReadFile(pathResolver.rootResolve(rel), { encoding: 'utf8' }) as string;
}

function readJSON<T = any>(rel: string): T {
  return readFoundationJson<T>(pathResolver.rootResolve(rel));
}

function writeJSON(rel: string, data: any): string {
  const abs = pathResolver.rootResolve(rel);
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
  const src = readJSON<any>(input.source_path);
  const pool: any[] = src.hypotheses || src.items || [];

  const rejected = pool.filter((h) => {
    if (h.status) return h.status === 'rejected';
    if (typeof h.survived === 'boolean') return !h.survived;
    return false;
  });

  const dissents = rejected.map((h) => ({
    hypothesis: h.content || h.hypothesis || h.summary || JSON.stringify(h),
    proposed_by: h.proposed_by || h.persona || 'unknown',
    rejection_reason: h.rejection_reason || h.critique || 'not-provided',
    rejection_confidence: h.rejection_confidence || 'medium',
    revisit_triggers: h.revisit_triggers || [],
    evidence_refs: h.evidence_refs || [],
  }));

  let existing: any = null;
  if (input.append && safeExistsSync(pathResolver.rootResolve(input.output_path))) {
    existing = readJSON(input.output_path);
  }

  const payload = existing
    ? { ...existing, dissents: [...(existing.dissents || []), ...dissents] }
    : {
        mission_id: input.mission_id || src.mission_id || 'unknown',
        topic: input.topic || src.topic || 'unspecified',
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
  const src = readJSON<any>(input.source_path);
  const topic: string = src.topic || '';
  const hypotheses: any[] = src.hypotheses || [];
  const generatedBy: string = src.generated_by || 'unknown';
  const generatedAt: string = src.generated_at || '';

  const byPersona = new Map<string, any[]>();
  for (const h of hypotheses) {
    const key = h.proposed_by || 'unknown';
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
      lines.push(`#### ${statusEmoji} ${h.id || '(no-id)'}`);
      lines.push('');
      lines.push(h.content || '(no content)');
      lines.push('');
      if (h.survived === false && h.rejection_reason) {
        lines.push(`> **Rejected because**: ${h.rejection_reason}`);
        lines.push('');
      }
      if (Array.isArray(h.critiques) && h.critiques.length > 0) {
        lines.push('**Critiques:**');
        lines.push('');
        for (const c of h.critiques) {
          lines.push(`- *by ${c.by || 'unknown'}*: ${c.content || ''}`);
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

  safeMkdir(path.dirname(pathResolver.rootResolve(input.output_path)), { recursive: true });
  safeWriteFile(pathResolver.rootResolve(input.output_path), lines.join('\n'));
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
  const src = readJSON<any>(input.source_path);
  const hypotheses: any[] = Array.isArray(src.hypotheses) ? src.hypotheses : [];
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
    winner_id: winner?.id ?? null,
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
  const abs = pathResolver.rootResolve(out);
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, original + block);
  return { written_to: out };
}
