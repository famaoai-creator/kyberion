/**
 * Memory notebook line grammar and fold/consolidation primitives (QM-03).
 *
 * Ported from yc-software/qm (MIT License, commit 7f2c916):
 *   src/memory/notebook.ts (line grammar)
 *   src/memory/memory-service.ts (foldCapture, queryBullets)
 *   src/memory/strategies/consolidation.ts (action grammar, marker)
 *
 * This module is the SINGLE source of truth for the bullet-notebook format
 * (`- (YYYY-MM-DD) fact`). Every subsystem that reads or writes notebook-style
 * memory (working-memory actuator, promotion flows, distill) must import the
 * grammar from here instead of re-implementing it.
 *
 * Two invariants the fold upholds:
 *  - Provenance neutralization: an untrusted extraction model cannot forge
 *    `(said in X)` provenance — untrusted folds rewrite it to
 *    `[claimed source: X]` so forged scope claims never read as trusted.
 *  - Bounded notebooks: past MAX_FACTS the OLDEST bullets are dropped; the
 *    notebook is an index of facts, never an unbounded log.
 *
 * Consolidation is a line-oriented action list (UPDATE n / DELETE n / ADD /
 * NONE) so a model pass can be parsed, diffed, and — in kyberion — routed
 * through the hash-bound background-review approval flow instead of applied
 * blindly.
 */

export const RECALL_MAX_CHARS = 6_000;
export const MAX_FACTS = 300;
export const MEMORY_HEADER = '# Memory';

export function isBullet(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('- ') || t.startsWith('* ');
}

export function bulletText(line: string): string {
  return line
    .trimStart()
    .replace(/^[-*]\s*/, '')
    .trim();
}

export function captureDate(text: string): string | undefined {
  return /^\((\d{4}-\d\d-\d\d)\)/.exec(text)?.[1];
}

export function bullets(body: string): string[] {
  return body.split('\n').filter(isBullet).map(bulletText);
}

export function normalize(line: string): string {
  return line
    .replace(/^[-*]\s*/, '')
    .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, '')
    .trim()
    .toLowerCase();
}

export function dateStr(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function capTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export function recallBody(body: string): string {
  const trimmed = body.trim();
  return trimmed ? capTail(trimmed, RECALL_MAX_CHARS) : '';
}

/**
 * Rewrites model-authored provenance so it can never impersonate the trusted
 * form: a leading capture date becomes prose and a `(said in X)` suffix
 * becomes `[claimed source: X]`.
 */
export function neutralizeUntrustedProvenance(text: string): string {
  return text
    .replace(/^\((\d{4}-\d\d-\d\d)\)\s*/, 'on $1: ')
    .replace(/\s+\(said in ([^)]+)\)\s*$/i, ' [claimed source: $1]');
}

export interface FoldCaptureResult {
  body: string;
  added: number;
}

/**
 * Normalize one candidate before it crosses into a durable promotion queue.
 *
 * The queue stores a summary rather than a whole notebook, so callers must
 * not reimplement the fold just to obtain the canonical fact text.  The
 * returned value deliberately omits the capture date; the queue owns its
 * timestamp while this helper owns whitespace, dedupe grammar, and provenance
 * neutralization.
 */
export function normalizeMemoryFact(fact: string, at: number, trustedProvenance = false): string {
  const folded = foldCapture('', [fact], at, trustedProvenance);
  const first = bullets(folded.body)[0] || '';
  return first.replace(/^\(\d{4}-\d\d-\d\d\)\s*/u, '').trim();
}

export function foldCapture(
  existing: string,
  facts: string[],
  at: number,
  trustedProvenance = false
): FoldCaptureResult {
  const clean = facts
    .map((fact) => {
      let text = fact
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-*]\s+/, '');
      if (!trustedProvenance) text = neutralizeUntrustedProvenance(text);
      return text;
    })
    .filter(Boolean);
  if (!clean.length) return { body: existing, added: 0 };

  const seen = new Set(existing.split('\n').filter(isBullet).map(normalize));
  const date = dateStr(at);
  const added: string[] = [];
  for (const fact of clean) {
    const key = normalize(fact);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(`- (${date}) ${fact}`);
  }
  if (!added.length) return { body: existing, added: 0 };

  let body = existing.trim()
    ? `${existing.replace(/\s+$/, '')}\n${added.join('\n')}`
    : `${MEMORY_HEADER}\n\n${added.join('\n')}`;

  const lines = body.split('\n');
  const bulletIdx = lines.flatMap((line, i) => (isBullet(line) ? [i] : []));
  const overflow = bulletIdx.length - MAX_FACTS;
  if (overflow > 0) {
    const drop = new Set(bulletIdx.slice(0, overflow));
    body = lines.filter((_, i) => !drop.has(i)).join('\n');
  }
  return { body, added: added.length };
}

export function queryBullets(body: string, q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return bullets(body)
    .filter((line) => terms.every((term) => line.toLowerCase().includes(term)))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Consolidation (V-layer action grammar; application is approval-gated)
// ---------------------------------------------------------------------------

export const DEFAULT_CONSOLIDATE_AFTER = 10;

const MARKER_PREFIX = '<!-- consolidated:';

export function consolidationMarker(at: number): string {
  return `${MARKER_PREFIX} ${dateStr(at)} -->`;
}

function isMarker(line: string): boolean {
  return line.trim().startsWith(MARKER_PREFIX);
}

/** New bullets since the last consolidation pass — the trigger counter. */
export function bulletsBelowMarker(body: string): number {
  const lines = body.split('\n');
  let lastMarker = -1;
  for (let i = 0; i < lines.length; i++) if (isMarker(lines[i]!)) lastMarker = i;
  return lines.slice(lastMarker + 1).filter(isBullet).length;
}

export const MEMORY_CONSOLIDATION_PROMPT = [
  "You consolidate an agent's long-term memory notebook. The input is a numbered list",
  'of remembered facts (each may start with a (YYYY-MM-DD) capture date).',
  'Output ONLY actions, one per line, in these exact forms:',
  'UPDATE <n>: <revised fact>',
  'DELETE <n>',
  'ADD: <new fact>',
  'If nothing needs changing, output exactly: NONE',
  '',
  'Rules:',
  '- Prefer UPDATE over DELETE+ADD when a fact has evolved or two facts should merge',
  '  (UPDATE one, DELETE the other).',
  '- Keep facts atomic: one standalone fact per line. Split a compound fact with an',
  '  UPDATE plus ADDs.',
  '- DELETE facts that are stale, contradicted by newer facts, exact or near',
  '  duplicates, or trivially derivable from other facts.',
  '- DELETE pure system mechanics that can be looked up when needed (API endpoints/headers,',
  '  credential/broker plumbing, state-file paths, tool invocation details) — but KEEP',
  '  user-stated conventions about them, and keep one existence-level fact for a standing',
  '  system the user relies on (a cron, a watcher, an integration).',
  '- NEVER delete or weaken a fact the user explicitly asked to remember.',
  '- Preserve any `(said in …)` or `[claimed source: …]` suffix verbatim — it records where',
  '  a fact was stated and scopes it. Keep it through an UPDATE, and never merge two facts',
  '  that carry different sources.',
  '- Do not reword facts that are already fine. When in doubt, leave a fact alone.',
].join('\n');

export type ConsolidationAction =
  | { kind: 'update'; index: number; text: string }
  | { kind: 'delete'; index: number }
  | { kind: 'add'; text: string };

export function parseConsolidationActions(out: string): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;
    let m = /^UPDATE\s+(\d+)\s*:\s*(.+)$/i.exec(line);
    if (m) {
      actions.push({ kind: 'update', index: Number(m[1]), text: m[2]!.trim() });
      continue;
    }
    m = /^DELETE\s+(\d+)\s*$/i.exec(line);
    if (m) {
      actions.push({ kind: 'delete', index: Number(m[1]) });
      continue;
    }
    m = /^ADD\s*:\s*(.+)$/i.exec(line);
    if (m) actions.push({ kind: 'add', text: m[1]!.trim() });
  }
  return actions;
}

function formatBullet(text: string, date: string): string {
  return captureDate(text) ? `- ${text}` : `- (${date}) ${text}`;
}

/**
 * Ordinal contract: `UPDATE n` / `DELETE n` count EVERY line `isBullet`
 * accepts (including `* ` bullets and checkbox items), in file order. The
 * numbered list shown to the model MUST be built from the same
 * `bullets()`/`isBullet` walk, or the actions will target the wrong facts.
 *
 * ADD actions are model-authored NEW facts, so their provenance is
 * neutralized — the model must not be able to mint a trusted
 * `(said in X)` suffix through consolidation. UPDATE keeps existing
 * suffixes verbatim per the prompt contract.
 */
export function applyConsolidationActions(
  body: string,
  actions: ConsolidationAction[],
  at: number
): string {
  const today = dateStr(at);
  const updates = new Map<number, string>();
  const deletes = new Set<number>();
  const adds: string[] = [];
  for (const action of actions) {
    if (action.kind === 'update') updates.set(action.index, action.text);
    else if (action.kind === 'delete') deletes.add(action.index);
    else adds.push(action.text);
  }

  const out: string[] = [];
  let n = 0;
  for (const line of body.split('\n')) {
    if (isMarker(line)) {
      if (out[out.length - 1]?.trim() === '') out.pop();
      continue;
    }
    if (!isBullet(line)) {
      out.push(line);
      continue;
    }
    n++;
    if (deletes.has(n)) continue;
    const updated = updates.get(n);
    out.push(
      updated !== undefined ? formatBullet(updated, captureDate(bulletText(line)) ?? today) : line
    );
  }
  for (const text of adds) out.push(formatBullet(neutralizeUntrustedProvenance(text), today));

  const trimmed = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  return `${trimmed}\n\n${consolidationMarker(at)}`;
}

export interface ConsolidationPlan {
  actions: ConsolidationAction[];
  nextBody: string;
  changed: boolean;
}

/**
 * Parses a model consolidation pass into an applicable plan WITHOUT applying
 * it — kyberion routes the plan through the hash-bound background-review
 * approval flow (KM-03) rather than letting a model rewrite memory directly.
 */
export function planConsolidation(
  body: string,
  modelOutput: string,
  at: number
): ConsolidationPlan {
  const actions = parseConsolidationActions(modelOutput);
  if (!actions.length) return { actions, nextBody: body, changed: false };
  const nextBody = applyConsolidationActions(body, actions, at);
  return { actions, nextBody, changed: nextBody !== body };
}
