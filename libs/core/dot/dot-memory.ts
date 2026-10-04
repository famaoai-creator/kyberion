/**
 * DL-05 — per-dot working memory.
 *
 * A bounded JSON document (notes, open items, hypotheses) the dot edits through
 * the `dot_update_memory` wake tool and sees again in its next prompt. Every
 * bound is deterministic: list caps, text length, a byte budget and a fixed
 * eviction order, so the same ops always yield the same document. Tenant prose
 * lives only in the `dotStatePath`-scoped file, never in a system-floor ledger.
 *
 * A weekly distillation turns resolved hypotheses into execution-feedback
 * candidates (reviewed by a human, never applied silently).
 */

import * as path from 'node:path';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import type { DotExtCtx, DotPromptSection, DotWakeTool } from './dot-extensions.js';
import {
  DOT_MEMORY_DISTILL_FILE,
  dotMemoryPath,
  dotStatePath,
  type DotMemoryDoc,
} from './dot-state-paths.js';

const logger = createLogger('dot-memory');

export const DOT_MEMORY_LIST_MAX = 20;
export const DOT_MEMORY_TEXT_MAX = 400;
export const DOT_MEMORY_DEFAULT_MAX_BYTES = 8 * 1024;
export const DOT_MEMORY_MIN_BYTES = 512;
export const DOT_MEMORY_OPS_PER_WAKE = 10;
/** Budget of the memory prompt section (characters). */
export const DOT_MEMORY_PROMPT_BUDGET = 1500;

export type DotMemoryOp =
  | { op: 'add_note'; text: string }
  | { op: 'add_item'; text: string; due?: string }
  | { op: 'close_item'; id: string }
  | { op: 'add_hypothesis'; text: string; confidence?: number }
  | { op: 'resolve_hypothesis'; id: string; status: 'confirmed' | 'refuted' }
  | { op: 'remove'; id: string };

export const dotMemoryEnabled = (c: DotCharter): boolean => c.memory?.enabled !== false;

export function dotMemoryMaxBytes(c: DotCharter): number {
  const configured = c.memory?.max_bytes;
  return typeof configured === 'number' && Number.isFinite(configured)
    ? Math.max(DOT_MEMORY_MIN_BYTES, Math.floor(configured))
    : DOT_MEMORY_DEFAULT_MAX_BYTES;
}

export function emptyDotMemory(dotId: string, now: Date): DotMemoryDoc {
  return {
    dot_id: dotId,
    version: 1,
    updated_at: now.toISOString(),
    last_ids: { n: 0, i: 0, h: 0 },
    notes: [],
    open_items: [],
    hypotheses: [],
  };
}

function absolute(rel: string, ctx: { rootDir?: string }): string {
  return path.join(ctx.rootDir ?? pathResolver.rootDir(), rel);
}

export function readDotMemory(
  c: DotCharter,
  ctx: { rootDir?: string; now?: () => Date }
): DotMemoryDoc {
  const fresh = emptyDotMemory(c.dot_id, ctx.now?.() ?? new Date());
  let doc: DotMemoryDoc | null;
  try {
    doc = readJsonIfPresent<DotMemoryDoc>(absolute(dotMemoryPath(c), ctx));
  } catch (error) {
    logger.warn(
      `memory unreadable for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: starting from an empty memory | evidence: ${dotMemoryPath(c)}`
    );
    doc = null;
  }
  const next: DotMemoryDoc =
    doc?.version === 1
      ? {
          ...fresh,
          updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : fresh.updated_at,
          last_ids: doc.last_ids,
          notes: Array.isArray(doc.notes) ? doc.notes : [],
          open_items: Array.isArray(doc.open_items) ? doc.open_items : [],
          hypotheses: Array.isArray(doc.hypotheses) ? doc.hypotheses : [],
        }
      : fresh;
  // Legacy memories had no high-water marks. A removed, already-distilled
  // hypothesis can survive only in history, so seed from that ledger too.
  // An unreadable ledger must fail this migration rather than reuse an ID.
  const historicalIds = !doc?.last_ids
    ? readJsonLines<DotMemoryDistillRow>(absolute(dotStatePath(c, DOT_MEMORY_DISTILL_FILE), ctx))
        .filter((row) => row.dot_id === c.dot_id)
        .flatMap((row) => row.hypothesis_ids ?? [])
    : [];
  next.last_ids = memoryIdHighWater(next, historicalIds);
  return next;
}

const sizeOf = (doc: DotMemoryDoc): number => Buffer.byteLength(JSON.stringify(doc), 'utf8');

/** Index of the entry a list evicts first: preferred (closed/resolved) oldest, else oldest. */
function evictIndex<T>(list: T[], preferred?: (entry: T) => boolean): number {
  const first = preferred ? list.findIndex(preferred) : -1;
  return first >= 0 ? first : 0;
}

const isClosed = (i: DotMemoryDoc['open_items'][number]): boolean => i.status === 'closed';
const isResolved = (h: DotMemoryDoc['hypotheses'][number]): boolean => h.status !== 'open';

/**
 * Deterministic bounding. Lists over the cap drop (closed | resolved) oldest
 * first; over the byte budget the order is closed items, resolved hypotheses,
 * oldest notes, then oldest open items / hypotheses as a last resort.
 */
export function boundDotMemory(doc: DotMemoryDoc, maxBytes: number): DotMemoryDoc {
  const next: DotMemoryDoc = {
    ...doc,
    last_ids: memoryIdHighWater(doc),
    notes: [...doc.notes],
    open_items: [...doc.open_items],
    hypotheses: [...doc.hypotheses],
  };
  while (next.notes.length > DOT_MEMORY_LIST_MAX) next.notes.shift();
  while (next.open_items.length > DOT_MEMORY_LIST_MAX) {
    next.open_items.splice(evictIndex(next.open_items, isClosed), 1);
  }
  while (next.hypotheses.length > DOT_MEMORY_LIST_MAX) {
    next.hypotheses.splice(evictIndex(next.hypotheses, isResolved), 1);
  }
  while (sizeOf(next) > maxBytes) {
    const closed = next.open_items.findIndex(isClosed);
    if (closed >= 0) {
      next.open_items.splice(closed, 1);
      continue;
    }
    const resolved = next.hypotheses.findIndex(isResolved);
    if (resolved >= 0) {
      next.hypotheses.splice(resolved, 1);
      continue;
    }
    if (next.notes.length) {
      next.notes.shift();
      continue;
    }
    if (next.open_items.length) {
      next.open_items.shift();
      continue;
    }
    if (next.hypotheses.length) {
      next.hypotheses.shift();
      continue;
    }
    break;
  }
  return next;
}

const clipText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, DOT_MEMORY_TEXT_MAX) : undefined;
};

const clipId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.trim())
    ? value.trim()
    : undefined;

/** Validate one untrusted op. */
export function parseDotMemoryOp(
  input: unknown
): { ok: true; value: DotMemoryOp } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'op must be an object' };
  }
  const raw = input as Record<string, unknown>;
  switch (raw.op) {
    case 'add_note': {
      const text = clipText(raw.text);
      return text
        ? { ok: true, value: { op: 'add_note', text } }
        : { ok: false, error: 'add_note needs text' };
    }
    case 'add_item': {
      const text = clipText(raw.text);
      if (!text) return { ok: false, error: 'add_item needs text' };
      const due =
        typeof raw.due === 'string' && Number.isFinite(Date.parse(raw.due)) ? raw.due : undefined;
      return { ok: true, value: { op: 'add_item', text, ...(due ? { due } : {}) } };
    }
    case 'add_hypothesis': {
      const text = clipText(raw.text);
      if (!text) return { ok: false, error: 'add_hypothesis needs text' };
      const conf =
        typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
          ? raw.confidence
          : 0.5;
      return {
        ok: true,
        value: { op: 'add_hypothesis', text, confidence: Math.min(1, Math.max(0, conf)) },
      };
    }
    case 'close_item':
    case 'remove': {
      const id = clipId(raw.id);
      return id
        ? { ok: true, value: { op: raw.op, id } }
        : { ok: false, error: `${String(raw.op)} needs a valid id` };
    }
    case 'resolve_hypothesis': {
      const id = clipId(raw.id);
      if (!id) return { ok: false, error: 'resolve_hypothesis needs a valid id' };
      if (raw.status !== 'confirmed' && raw.status !== 'refuted') {
        return { ok: false, error: "resolve_hypothesis status must be 'confirmed' or 'refuted'" };
      }
      return { ok: true, value: { op: 'resolve_hypothesis', id, status: raw.status } };
    }
    default:
      return { ok: false, error: `unknown op '${String(raw.op)}'` };
  }
}

function maxId(prefix: string, ids: string[], previous = 0): number {
  let max = Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  for (const id of ids) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m && Number.isSafeInteger(Number(m[1]))) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function memoryIdHighWater(
  doc: DotMemoryDoc,
  historicalIds: string[] = []
): NonNullable<DotMemoryDoc['last_ids']> {
  return {
    n: maxId(
      'n',
      doc.notes.map((entry) => entry.id),
      doc.last_ids?.n
    ),
    i: maxId(
      'i',
      doc.open_items.map((entry) => entry.id),
      doc.last_ids?.i
    ),
    h: maxId('h', [...doc.hypotheses.map((entry) => entry.id), ...historicalIds], doc.last_ids?.h),
  };
}

function nextId(prefix: 'n' | 'i' | 'h', ids: NonNullable<DotMemoryDoc['last_ids']>): string {
  if (ids[prefix] >= Number.MAX_SAFE_INTEGER) throw new Error('dot memory ID sequence exhausted');
  ids[prefix] += 1;
  return `${prefix}-${ids[prefix]}`;
}

/** Apply ops (at most {@link DOT_MEMORY_OPS_PER_WAKE}) to a document; returns the bounded result and errors. */
export function applyDotMemoryOps(
  doc: DotMemoryDoc,
  ops: readonly DotMemoryOp[],
  now: Date,
  maxBytes: number
): { doc: DotMemoryDoc; errors: string[] } {
  const errors: string[] = [];
  const at = now.toISOString();
  let next: DotMemoryDoc = {
    ...doc,
    last_ids: memoryIdHighWater(doc),
    notes: [...doc.notes],
    open_items: [...doc.open_items],
    hypotheses: [...doc.hypotheses],
  };
  ops.slice(0, DOT_MEMORY_OPS_PER_WAKE).forEach((op) => {
    switch (op.op) {
      case 'add_note':
        next.notes.push({
          id: nextId('n', next.last_ids!),
          text: op.text,
          at,
        });
        break;
      case 'add_item':
        next.open_items.push({
          id: nextId('i', next.last_ids!),
          text: op.text,
          status: 'open',
          ...(op.due ? { due: op.due } : {}),
          at,
        });
        break;
      case 'add_hypothesis':
        next.hypotheses.push({
          id: nextId('h', next.last_ids!),
          text: op.text,
          confidence: Math.min(1, Math.max(0, op.confidence ?? 0.5)),
          status: 'open',
          at,
        });
        break;
      case 'close_item': {
        const item = next.open_items.find((i) => i.id === op.id);
        if (item) item.status = 'closed';
        else errors.push(`close_item: no item '${op.id}'`);
        break;
      }
      case 'resolve_hypothesis': {
        const hyp = next.hypotheses.find((h) => h.id === op.id);
        if (hyp) hyp.status = op.status;
        else errors.push(`resolve_hypothesis: no hypothesis '${op.id}'`);
        break;
      }
      case 'remove': {
        const before = next.notes.length + next.open_items.length + next.hypotheses.length;
        next = {
          ...next,
          notes: next.notes.filter((n) => n.id !== op.id),
          open_items: next.open_items.filter((i) => i.id !== op.id),
          hypotheses: next.hypotheses.filter((h) => h.id !== op.id),
        };
        if (next.notes.length + next.open_items.length + next.hypotheses.length === before) {
          errors.push(`remove: no entry '${op.id}'`);
        }
        break;
      }
    }
  });
  if (ops.length > DOT_MEMORY_OPS_PER_WAKE) {
    errors.push(
      `dropped ${ops.length - DOT_MEMORY_OPS_PER_WAKE} ops (more than ${DOT_MEMORY_OPS_PER_WAKE} per wake)`
    );
  }
  next.updated_at = at;
  return { doc: boundDotMemory(next, maxBytes), errors };
}

export function writeDotMemory(c: DotCharter, doc: DotMemoryDoc, ctx: { rootDir?: string }): void {
  const file = absolute(dotMemoryPath(c), ctx);
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, doc);
}

const OP_SCHEMA = {
  type: 'object' as const,
  properties: {
    op: {
      type: 'string',
      enum: [
        'add_note',
        'add_item',
        'close_item',
        'add_hypothesis',
        'resolve_hypothesis',
        'remove',
      ],
    },
    id: { type: 'string', description: 'Entry id (close_item / resolve_hypothesis / remove).' },
    text: { type: 'string', description: `Up to ${DOT_MEMORY_TEXT_MAX} characters.` },
    due: { type: 'string', description: 'Optional ISO due time (add_item).' },
    confidence: { type: 'number', description: '0..1 (add_hypothesis).' },
    status: { type: 'string', enum: ['confirmed', 'refuted'], description: 'resolve_hypothesis.' },
  },
  required: ['op'],
};

export const dotUpdateMemoryTool: DotWakeTool = {
  name: 'dot_update_memory',
  fence: 'dot-memory',
  maxPerWake: DOT_MEMORY_OPS_PER_WAKE,
  definition: {
    name: 'dot_update_memory',
    description:
      'Edit your private working memory (notes, open items, hypotheses) so the next wake remembers it. Keep entries short; resolve hypotheses when evidence arrives.',
    inputSchema: OP_SCHEMA,
  },
  parse: (input) => parseDotMemoryOp(input),
  apply(c, values, ctx) {
    if (!dotMemoryEnabled(c)) return ['memory is disabled for this dot'];
    const ops = values as DotMemoryOp[];
    const now = ctx.now();
    const result = applyDotMemoryOps(
      readDotMemory(c, { rootDir: ctx.rootDir, now: ctx.now }),
      ops,
      now,
      dotMemoryMaxBytes(c)
    );
    writeDotMemory(c, result.doc, ctx);
    return result.errors;
  },
};

/** Prompt lines for the memory doc, within {@link DOT_MEMORY_PROMPT_BUDGET} characters. */
export function dotMemoryPromptLines(c: DotCharter, ctx: DotExtCtx): string[] {
  if (!dotMemoryEnabled(c)) return [];
  const doc = readDotMemory(c, ctx);
  const candidates: string[] = [
    ...doc.open_items
      .filter((i) => i.status === 'open')
      .map((i) => `- [${i.id}] open: ${i.text}${i.due ? ` (due ${i.due})` : ''}`),
    ...doc.hypotheses
      .filter((h) => h.status === 'open')
      .map((h) => `- [${h.id}] hypothesis (${h.confidence}): ${h.text}`),
    ...[...doc.notes].reverse().map((n) => `- [${n.id}] note: ${n.text}`),
  ];
  const header = 'Your working memory (edit with dot_update_memory):';
  if (candidates.length === 0) return [];
  const lines = [header];
  let used = header.length;
  for (const line of candidates) {
    if (used + line.length + 1 > DOT_MEMORY_PROMPT_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

export const dotMemoryPromptSection: DotPromptSection = {
  id: 'dot-memory',
  order: 50,
  lines: (c, ctx) => dotMemoryPromptLines(c, ctx),
};

// ---------------------------------------------------------------------------
// weekly distillation
// ---------------------------------------------------------------------------

export interface DotMemoryDistillRow {
  dot_id: string;
  key: string;
  at: string;
  confirmed: number;
  refuted: number;
  hypothesis_ids: string[];
  candidate_id?: string;
}

/** ISO-8601 week key, e.g. `2026-W41` (UTC). */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface DotMemoryDistillDeps {
  rootDir?: string;
  now?: () => Date;
  /**
   * Records the distilled feedback and returns the materialized candidate id.
   * Defaults to the global execution-feedback store (tests inject a stub).
   */
  recordFeedback?: (input: DotMemoryDistillFeedback) => Promise<{ candidate_id?: string }>;
}

export interface DotMemoryDistillFeedback {
  dot_id: string;
  tenant: boolean;
  key: string;
  outcome: 'satisfied' | 'dissatisfied';
  comment: string;
  correction?: string;
}

async function recordDistillFeedback(
  input: DotMemoryDistillFeedback
): Promise<{ candidate_id?: string }> {
  const { recordExecutionFeedback, materializeExecutionFeedbackCandidate } =
    await import('../execution-feedback.js');
  const feedback = recordExecutionFeedback({
    scenario_id: `dot-memory:${input.dot_id}`,
    intent_id: input.key,
    surface: 'dot',
    outcome: input.outcome,
    comment: input.comment,
    ...(input.correction ? { correction: input.correction } : {}),
    source: 'operator',
  });
  const { candidate } = materializeExecutionFeedbackCandidate({
    feedback,
    procedureId: `dot:${input.dot_id}`,
  });
  if (candidate && input.tenant) {
    const { updateDistillCandidateRecord } =
      await import('../knowledge/distill-candidate-registry.js');
    updateDistillCandidateRecord(candidate.candidate_id, { tier: 'confidential' });
  }
  return candidate ? { candidate_id: candidate.candidate_id } : {};
}

/**
 * Once per ISO week per dot: distill hypotheses resolved since the last
 * distillation into an execution-feedback record (+ review candidate). Tenant
 * dots keep prose out of the shared feedback store (counts only) and their
 * candidate is tiered `confidential`.
 */
export async function distillDotMemory(
  c: DotCharter,
  deps: DotMemoryDistillDeps = {}
): Promise<DotMemoryDistillRow | undefined> {
  if (!dotMemoryEnabled(c)) return undefined;
  const now = deps.now?.() ?? new Date();
  const key = `distill:${isoWeekKey(now)}`;
  const file = absolute(dotStatePath(c, DOT_MEMORY_DISTILL_FILE), deps);
  const rows = readJsonLines<DotMemoryDistillRow>(file, { onMalformed: 'skip' }).filter(
    (r) => r.dot_id === c.dot_id
  );
  if (rows.some((r) => r.key === key)) return undefined;
  const seen = new Set(rows.flatMap((r) => r.hypothesis_ids ?? []));
  const doc = readDotMemory(c, { rootDir: deps.rootDir, now: () => now });
  const fresh = doc.hypotheses.filter((h) => h.status !== 'open' && !seen.has(h.id));
  if (fresh.length === 0) return undefined;
  const confirmed = fresh.filter((h) => h.status === 'confirmed');
  const refuted = fresh.filter((h) => h.status === 'refuted');
  const tenant = Boolean(c.scope.tenant_slug);
  const summary = `Weekly memory distillation (${key}): ${confirmed.length} hypotheses confirmed, ${refuted.length} refuted.`;
  const prose = (list: typeof fresh) => list.map((h) => h.text).join(' | ');
  const candidate = await (deps.recordFeedback ?? recordDistillFeedback)({
    dot_id: c.dot_id,
    tenant,
    key,
    outcome: refuted.length > 0 ? 'dissatisfied' : 'satisfied',
    comment:
      tenant || confirmed.length === 0 ? summary : `${summary} Confirmed: ${prose(confirmed)}`,
    ...(!tenant && refuted.length ? { correction: `Refuted assumptions: ${prose(refuted)}` } : {}),
  });
  const row: DotMemoryDistillRow = {
    dot_id: c.dot_id,
    key,
    at: now.toISOString(),
    confirmed: confirmed.length,
    refuted: refuted.length,
    hypothesis_ids: fresh.map((h) => h.id),
    ...(candidate.candidate_id ? { candidate_id: candidate.candidate_id } : {}),
  };
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, row);
  return row;
}
