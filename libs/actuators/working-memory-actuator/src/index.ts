/**
 * working-memory-actuator
 * Volatile Knowledge Layer — CRUD + GC + index for working-memory faces.
 *
 * Dispatch: exported handleAction() satisfies run_pipeline.ts dispatch contract.
 * Invariant: all file I/O uses @agent/core secure-io (never node:fs directly).
 */

import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeReaddir,
} from '@agent/core';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateTier,
} from '@agent/core';
import type { VolatileScope, VolatileCadence } from '@agent/core';

const pr = pathResolver;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VolatileStatus = 'active' | 'expired' | 'rolled-over' | 'promoted' | 'archived';
export type VolatileTier = 'personal' | 'confidential' | 'public';
export type VolatileLifetime =
  | 'session' | 'mission' | 'daily' | 'weekly' | 'ttl' | 'until-distilled' | 'sticky';

export interface VolatileSidecar {
  $schema: string;
  scope: VolatileScope;
  scope_ref: string | null;
  cadence: VolatileCadence;
  period_key: string | null;
  tier: VolatileTier;
  lifetime: VolatileLifetime;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  rollover_to: string | null;
  rollup_to: string | null;
  promote_target: string | null;
  promotion_candidate_id: string | null;
  status: VolatileStatus;
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SCHEMA_REF = '../../../schemas/volatile-knowledge.schema.json';

function isoNow(): string { return new Date().toISOString(); }

function isoDate(): string { return new Date().toISOString().slice(0, 10); }

/**
 * ISO 8601 week string (YYYY-Www). UTC-based to avoid timezone boundary splits.
 */
function isoWeek(d: Date = new Date()): string {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dailyExpiry(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString();
}

function weeklyExpiry(): string {
  const d = new Date();
  const daysUntilSunday = (7 - d.getUTCDay()) % 7 || 7;
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilSunday, 23, 59, 59, 999));
  return new Date(end.getTime() + 8 * 7 * 24 * 3600 * 1000).toISOString();
}

function ensureDir(dir: string): void {
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function sidecarPath(mdPath: string): string {
  return mdPath.endsWith('.md') ? mdPath.slice(0, -3) + '.volatile.json' : mdPath + '.volatile.json';
}

function loadSidecar(mdPath: string): VolatileSidecar | null {
  const sp = sidecarPath(mdPath);
  if (!safeExistsSync(sp)) return null;
  try { return JSON.parse(safeReadFile(sp, { encoding: 'utf8' }) as string) as VolatileSidecar; }
  catch { return null; }
}

function saveSidecar(mdPath: string, sidecar: VolatileSidecar): void {
  const sp = sidecarPath(mdPath);
  ensureDir(path.dirname(sp));
  safeWriteFile(sp, JSON.stringify(sidecar, null, 2));
}

function touchSidecar(mdPath: string, patch: Partial<VolatileSidecar>): VolatileSidecar {
  const existing = loadSidecar(mdPath);
  const now = isoNow();
  const merged = { ...existing, ...patch, updated_at: now } as VolatileSidecar;
  if (!merged.created_at) merged.created_at = now;
  saveSidecar(mdPath, merged);
  return merged;
}

function scopeDefaultTier(scope: VolatileScope): VolatileTier {
  return scope === 'personal' ? 'personal' : 'confidential';
}

function scopeDefaultLifetime(scope: VolatileScope): VolatileLifetime {
  switch (scope) {
    case 'session': return 'session';
    case 'mission': return 'mission';
    default: return 'until-distilled';
  }
}

function personalDir(): string {
  const d = pr.active('personal');
  ensureDir(d);
  return d;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function memoryTemplate(title: string): string {
  return `# ${title}\n\n## Action Items\n\n## Decisions\n\n## Open Questions\n\n## Notes\n\n`;
}

function nowTemplate(): string {
  return `# NOW\n\n> Current focus and next action. Updated each session.\n\n## Current Focus\n\n## Next Action\n\n## Context\n\n`;
}

function dailyJournalTemplate(date: string): string {
  return `# Daily Journal — ${date}\n\n## TODO\n\n## Done\n\n## Notes\n\n`;
}

function weeklyTemplate(weekKey: string): string {
  return `# Weekly Review — ${weekKey}\n\n## Highlights\n\n## Lessons\n\n## Carryover\n\n## Daily Log Links\n\n`;
}

function todoTemplate(date: string): string {
  return `# Today's TODO — ${date}\n\n> Pending items carry over to tomorrow automatically.\n\n`;
}

// ---------------------------------------------------------------------------
// Op implementations
// ---------------------------------------------------------------------------

function opNote(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);
  const section = (params.section as string) ?? 'Notes';
  const content = String(params.content ?? '');

  const dir = pr.volatile(scope, scopeRef, { tier });
  ensureDir(dir);
  const mdPath = path.join(dir, 'MEMORY.md');
  if (!safeExistsSync(mdPath)) safeWriteFile(mdPath, memoryTemplate('Working Memory'));

  const existing = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
  const target = `## ${section}`;
  const idx = existing.indexOf(target);
  let updated: string;
  if (idx >= 0) {
    const insertAt = existing.indexOf('\n', idx) + 1;
    updated = existing.slice(0, insertAt) + `\n- ${content}\n` + existing.slice(insertAt);
  } else {
    updated = existing.trimEnd() + `\n\n## ${section}\n\n- ${content}\n`;
  }
  safeWriteFile(mdPath, updated);
  const sidecar = touchSidecar(mdPath, {
    $schema: SCHEMA_REF, scope, scope_ref: scopeRef, cadence: 'resident', period_key: null,
    tier, lifetime: scopeDefaultLifetime(scope), expires_at: null, rollover_to: null,
    rollup_to: null, promote_target: null, promotion_candidate_id: null,
    status: 'active', pinned: false,
  });
  return { path: mdPath, sidecar };
}

function opSetNow(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);

  const dir = pr.volatile(scope, scopeRef, { tier });
  ensureDir(dir);
  const mdPath = path.join(dir, 'NOW.md');
  const text = [
    '# NOW', '', `> Updated: ${isoNow()}`, '',
    '## Current Focus', '', String(params.focus ?? ''), '',
    '## Next Action', '', String(params.nextAction ?? ''), '',
    '## Context', '', String(params.context ?? ''), '',
  ].join('\n');
  safeWriteFile(mdPath, text);
  const sidecar = touchSidecar(mdPath, {
    $schema: SCHEMA_REF, scope, scope_ref: scopeRef, cadence: 'resident', period_key: null,
    tier, lifetime: scopeDefaultLifetime(scope), expires_at: null, rollover_to: null,
    rollup_to: null, promote_target: null, promotion_candidate_id: null,
    status: 'active', pinned: false,
  });
  return { path: mdPath, sidecar };
}

function opAddActionItem(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);
  const item = String(params.item ?? '');

  const dir = pr.volatile(scope, scopeRef, { tier });
  ensureDir(dir);
  const mdPath = path.join(dir, 'MEMORY.md');
  if (!safeExistsSync(mdPath)) safeWriteFile(mdPath, memoryTemplate('Working Memory'));

  const existing = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
  const target = '## Action Items';
  const idx = existing.indexOf(target);
  let updated: string;
  if (idx >= 0) {
    const insertAt = existing.indexOf('\n', idx) + 1;
    updated = existing.slice(0, insertAt) + `\n- [ ] ${item}\n` + existing.slice(insertAt);
  } else {
    updated = existing.trimEnd() + `\n\n## Action Items\n\n- [ ] ${item}\n`;
  }
  safeWriteFile(mdPath, updated);
  touchSidecar(mdPath, { updated_at: isoNow(), status: 'active' });
  return { path: mdPath };
}

function opCompleteActionItem(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);
  const item = String(params.item ?? '');

  const dir = pr.volatile(scope, scopeRef, { tier });
  const mdPath = path.join(dir, 'MEMORY.md');
  if (!safeExistsSync(mdPath)) return { path: mdPath, found: false };

  const existing = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
  // Anchored end-of-line (^…$, multiline) prevents "Buy milk" matching "Buy milk chocolate"
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^- \\[ \\] ${escaped}$`, 'gm').test(existing)) return { path: mdPath, found: false };
  const updated = existing.replace(new RegExp(`^(- \\[ \\] ${escaped})$`, 'gm'), `- [x] ${item}`);
  safeWriteFile(mdPath, updated);
  touchSidecar(mdPath, { updated_at: isoNow() });
  return { path: mdPath, found: true };
}

function opDailyOpen(params: Record<string, unknown>): unknown {
  const dateStr = (params.date as string) ?? isoDate();
  const pDir = personalDir();
  const journalDir = path.join(pDir, 'journal');
  const todayDir = path.join(pDir, 'today');
  const weeklyDir = path.join(pDir, 'weekly');
  ensureDir(journalDir);
  ensureDir(todayDir);
  ensureDir(weeklyDir);

  const journalPath = path.join(journalDir, `${dateStr}.md`);
  if (!safeExistsSync(journalPath)) safeWriteFile(journalPath, dailyJournalTemplate(dateStr));

  const weekKey = isoWeek(new Date(`${dateStr}T12:00:00Z`));
  const journalSidecar = touchSidecar(journalPath, {
    $schema: SCHEMA_REF, scope: 'personal', scope_ref: null,
    cadence: 'daily', period_key: dateStr, tier: 'personal', lifetime: 'daily',
    expires_at: dailyExpiry(dateStr), rollover_to: null,
    rollup_to: path.join(weeklyDir, `${weekKey}.md`),
    promote_target: 'knowledge/product/governance/HINTS.md',
    promotion_candidate_id: null, status: 'active', pinned: false,
  });

  const todoPath = path.join(todayDir, 'TODO.md');
  if (!safeExistsSync(todoPath)) safeWriteFile(todoPath, todoTemplate(dateStr));
  const todoSidecar = touchSidecar(todoPath, {
    $schema: SCHEMA_REF, scope: 'personal', scope_ref: null,
    cadence: 'daily', period_key: dateStr, tier: 'personal', lifetime: 'daily',
    expires_at: dailyExpiry(dateStr), rollover_to: journalPath,
    rollup_to: null, promote_target: null, promotion_candidate_id: null,
    status: 'active', pinned: false,
  });

  return { journalPath, todoPath, journalSidecar, todoSidecar };
}

function opTodoAdd(params: Record<string, unknown>): unknown {
  const dateStr = (params.date as string) ?? isoDate();
  const item = String(params.item ?? '');
  const result = opDailyOpen({ date: dateStr }) as { todoPath: string };
  const existing = safeReadFile(result.todoPath, { encoding: 'utf8' }) as string;
  safeWriteFile(result.todoPath, existing.trimEnd() + `\n- [ ] ${item}\n`);
  touchSidecar(result.todoPath, { updated_at: isoNow() });
  return { path: result.todoPath };
}

function opTodoDone(params: Record<string, unknown>): unknown {
  const dateStr = (params.date as string) ?? isoDate();
  const item = String(params.item ?? '');
  const pDir = pr.active('personal');
  const todoPath = path.join(pDir, 'today', 'TODO.md');
  if (!safeExistsSync(todoPath)) return { path: todoPath, found: false };

  const existing = safeReadFile(todoPath, { encoding: 'utf8' }) as string;
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^- \\[ \\] ${escaped}$`, 'gm').test(existing)) return { path: todoPath, found: false };
  safeWriteFile(todoPath, existing.replace(new RegExp(`^(- \\[ \\] ${escaped})$`, 'gm'), `- [x] ${item}`));

  const journalPath = path.join(pDir, 'journal', `${dateStr}.md`);
  if (safeExistsSync(journalPath)) {
    const j = safeReadFile(journalPath, { encoding: 'utf8' }) as string;
    const doneIdx = j.indexOf('## Done');
    if (doneIdx >= 0) {
      const ins = j.indexOf('\n', doneIdx) + 1;
      safeWriteFile(journalPath, j.slice(0, ins) + `\n- [x] ${item}\n` + j.slice(ins));
    }
  }
  touchSidecar(todoPath, { updated_at: isoNow() });
  return { path: todoPath, found: true };
}

function opTodoRollover(params: Record<string, unknown>): unknown {
  const todayStr = (params.date as string) ?? isoDate();
  const pDir = pr.active('personal');
  const journalDir = path.join(pDir, 'journal');
  const todoPath = path.join(pDir, 'today', 'TODO.md');

  if (!safeExistsSync(todoPath)) return { rolledOver: 0, items: [] };

  const existing = safeReadFile(todoPath, { encoding: 'utf8' }) as string;
  const pendingLines = existing.split('\n').filter(l => /^- \[ \] /.test(l));
  if (pendingLines.length === 0) {
    touchSidecar(todoPath, { status: 'rolled-over' });
    return { rolledOver: 0, items: [] };
  }

  // Append pending items to today's journal
  const journalPath = path.join(journalDir, `${todayStr}.md`);
  if (safeExistsSync(journalPath)) {
    const j = safeReadFile(journalPath, { encoding: 'utf8' }) as string;
    const todoIdx = j.indexOf('## TODO');
    if (todoIdx >= 0) {
      const ins = j.indexOf('\n', todoIdx) + 1;
      safeWriteFile(journalPath, j.slice(0, ins) + '\n' + pendingLines.join('\n') + '\n' + j.slice(ins));
    }
  }

  // Rewrite TODO for next day
  const nextDay = new Date(`${todayStr}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  safeWriteFile(todoPath, todoTemplate(nextDayStr) + pendingLines.join('\n') + '\n');
  touchSidecar(todoPath, { status: 'rolled-over', period_key: nextDayStr, updated_at: isoNow() });

  return { rolledOver: pendingLines.length, items: pendingLines.map(l => l.replace(/^- \[ \] /, '')) };
}

function opWeeklyOpen(params: Record<string, unknown>): unknown {
  const weekKey = (params.weekKey as string) ?? isoWeek();
  const pDir = personalDir();
  const weeklyDir = path.join(pDir, 'weekly');
  const journalDir = path.join(pDir, 'journal');
  ensureDir(weeklyDir);
  ensureDir(journalDir);

  const weeklyPath = path.join(weeklyDir, `${weekKey}.md`);
  const dailyPaths: string[] = [];
  try {
    for (const entry of safeReaddir(journalDir)) {
      if (entry.endsWith('.md')) dailyPaths.push(path.join(journalDir, entry));
    }
  } catch { /* journal dir may not exist yet */ }

  if (!safeExistsSync(weeklyPath)) {
    const linkLines = dailyPaths.map(p => `- [${path.basename(p)}](${p})`).join('\n');
    safeWriteFile(weeklyPath, weeklyTemplate(weekKey) + (linkLines ? linkLines + '\n' : ''));
  }

  const sidecar = touchSidecar(weeklyPath, {
    $schema: SCHEMA_REF, scope: 'personal', scope_ref: null,
    cadence: 'weekly', period_key: weekKey, tier: 'personal', lifetime: 'weekly',
    expires_at: weeklyExpiry(), rollover_to: null, rollup_to: null,
    promote_target: 'knowledge/product/governance/HINTS.md',
    promotion_candidate_id: null, status: 'active', pinned: false,
  });

  return { weeklyPath, sidecar, dailyPaths };
}

function opNominatePromotion(params: Record<string, unknown>): unknown {
  const mdPath = String(params.mdPath ?? '');
  const summary = String(params.summary ?? 'Distillation candidate from volatile working-memory face');
  const sourceType = (params.source_type as 'mission' | 'task_session' | 'artifact' | 'incident') ?? 'task_session';
  const proposedKind = (params.proposed_memory_kind as MemoryCandidateKind) ?? 'heuristic';
  const sensitivityTier = (params.sensitivity_tier as MemoryCandidateTier) ?? 'personal';
  const evidenceRefs: string[] = Array.isArray(params.evidence_refs)
    ? (params.evidence_refs as string[])
    : mdPath ? [mdPath] : [];

  if (evidenceRefs.length === 0) return { nominated: false, reason: 'no evidence_refs' };

  const candidate = createMemoryPromotionCandidate({
    sourceType, sourceRef: mdPath || 'volatile-face',
    proposedMemoryKind: proposedKind, summary, evidenceRefs, sensitivityTier,
    ratificationRequired: sensitivityTier !== 'personal',
  });
  enqueueMemoryPromotionCandidate(candidate);

  if (mdPath && safeExistsSync(mdPath)) {
    touchSidecar(mdPath, { promotion_candidate_id: candidate.candidate_id, status: 'promoted' });
  }

  return { nominated: true, candidateId: candidate.candidate_id };
}

function opRead(params: Record<string, unknown>): unknown {
  const mdPath = String(params.mdPath ?? '');
  const content = safeExistsSync(mdPath) ? (safeReadFile(mdPath, { encoding: 'utf8' }) as string) : null;
  return { content, sidecar: loadSidecar(mdPath) };
}

function opList(params: Record<string, unknown>): unknown {
  const indexPath = pr.active('INDEX.volatile.json');
  if (!safeExistsSync(indexPath)) return [];
  try {
    const all = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string) as Array<{ mdPath: string; sidecar: VolatileSidecar }>;
    return all.filter(entry => {
      if (params.scope && entry.sidecar.scope !== params.scope) return false;
      if (params.cadence && entry.sidecar.cadence !== params.cadence) return false;
      if (params.status && entry.sidecar.status !== params.status) return false;
      return true;
    });
  } catch { return []; }
}

/**
 * Full GC pass: scans all *.volatile.json under active/, enforces lifetime policies.
 * Replaces the three-script approach; all logic is inline and auditable here.
 */
function opRunGc(params: Record<string, unknown>): unknown {
  const activeRoot = pr.active();
  const now = isoNow();
  const results = { expired: 0, rolledOver: 0, warnings: [] as string[] };

  function scanDir(dir: string): void {
    let entries: string[];
    try { entries = safeReaddir(dir); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (entry.endsWith('.volatile.json')) {
        let sidecar: VolatileSidecar;
        try {
          sidecar = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string) as VolatileSidecar;
        } catch {
          results.warnings.push(`malformed sidecar skipped: ${fullPath}`);
          continue;
        }
        if (sidecar.status === 'archived' || sidecar.status === 'promoted') continue;
        if (sidecar.expires_at && sidecar.expires_at < now && !sidecar.pinned) {
          try {
            safeWriteFile(fullPath, JSON.stringify({ ...sidecar, status: 'expired', updated_at: now }, null, 2));
            results.expired++;
          } catch (writeErr: any) {
            results.warnings.push(`write blocked (${writeErr?.message ?? writeErr}): ${fullPath}`);
          }
        }
      } else if (!entry.includes('.')) {
        if (!fullPath.includes(`${path.sep}archive${path.sep}`)) scanDir(fullPath);
      }
    }
  }

  scanDir(activeRoot);

  try {
    const r = opTodoRollover(params) as { rolledOver: number };
    results.rolledOver = r.rolledOver;
  } catch { /* no personal dir yet */ }

  return results;
}

/**
 * Build active/INDEX.volatile.{md,json}. Replaces volatile_index_build.js.
 */
function opBuildIndex(_params: Record<string, unknown>): unknown {
  const activeRoot = pr.active();
  const faces: Array<{ mdPath: string; sidecar: VolatileSidecar }> = [];

  function scanDir(dir: string): void {
    let entries: string[];
    try { entries = safeReaddir(dir); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      if (entry.endsWith('.volatile.json')) {
        try {
          const sidecar = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string) as VolatileSidecar;
          faces.push({ mdPath: fullPath.replace(/\.volatile\.json$/, '.md'), sidecar });
        } catch { /* skip */ }
      } else if (!entry.includes('.')) {
        if (!fullPath.includes(`${path.sep}archive${path.sep}`)) scanDir(fullPath);
      }
    }
  }

  scanDir(activeRoot);
  faces.sort((a, b) => a.sidecar.scope.localeCompare(b.sidecar.scope) || a.mdPath.localeCompare(b.mdPath));

  const jsonPath = pr.active('INDEX.volatile.json');
  const mdIndexPath = pr.active('INDEX.volatile.md');
  const relPath = (p: string) => p.startsWith(activeRoot) ? 'active' + p.slice(activeRoot.length) : p;
  const rows = faces.map(f =>
    `| ${relPath(f.mdPath)} | ${f.sidecar.scope} | ${f.sidecar.cadence} | ${f.sidecar.lifetime} | ${f.sidecar.expires_at ?? '—'} | ${f.sidecar.status} |`
  ).join('\n');
  const mdContent = [
    '# Volatile Knowledge Index', '',
    '> **Generated** — non-SSoT. Source of truth: individual `*.volatile.json` sidecars.',
    '> Run `pnpm pipeline --input pipelines/volatile-index.json` to refresh.', '',
    '| Path | Scope | Cadence | Lifetime | Expires | Status |',
    '|---|---|---|---|---|---|',
    rows, '',
  ].join('\n');

  safeWriteFile(jsonPath, JSON.stringify(faces, null, 2));
  safeWriteFile(mdIndexPath, mdContent);

  return { count: faces.length, jsonPath, mdIndexPath };
}

// ---------------------------------------------------------------------------
// initMissionMemory — called from mission-creation.ts on new mission creation
// ---------------------------------------------------------------------------

export function initMissionMemory(input: { missionId: string; tier?: VolatileTier }): { mdPath: string; nowPath: string } {
  const dir = pr.volatile('mission', input.missionId, { tier: input.tier ?? 'confidential' });
  const mdPath = path.join(dir, 'MEMORY.md');
  const nowPath = path.join(dir, 'NOW.md');
  if (!safeExistsSync(mdPath)) safeWriteFile(mdPath, memoryTemplate(`Mission ${input.missionId} — Working Memory`));
  if (!safeExistsSync(nowPath)) safeWriteFile(nowPath, nowTemplate());
  const baseSidecar: Partial<VolatileSidecar> = {
    $schema: SCHEMA_REF, scope: 'mission', scope_ref: input.missionId,
    cadence: 'resident', period_key: null, tier: input.tier ?? 'confidential',
    lifetime: 'mission', expires_at: null, rollover_to: null, rollup_to: null,
    promotion_candidate_id: null, status: 'active', pinned: false,
  };
  touchSidecar(mdPath, { ...baseSidecar, promote_target: 'knowledge/product/governance/HINTS.md' });
  touchSidecar(nowPath, { ...baseSidecar, promote_target: null });
  return { mdPath, nowPath };
}

// ---------------------------------------------------------------------------
// Dispatch table & handleAction export
// ---------------------------------------------------------------------------

const OPS: Record<string, (params: Record<string, unknown>) => unknown> = {
  'note': opNote,
  'set-now': opSetNow,
  'add-action-item': opAddActionItem,
  'complete-action-item': opCompleteActionItem,
  'daily-open': opDailyOpen,
  'todo-add': opTodoAdd,
  'todo-done': opTodoDone,
  'todo-rollover': opTodoRollover,
  'weekly-open': opWeeklyOpen,
  'nominate-promotion': opNominatePromotion,
  'run-gc': opRunGc,
  'build-index': opBuildIndex,
  'read': opRead,
  'list': opList,
};

function dispatchOp(op: string, params: Record<string, unknown>): unknown {
  const key = op.includes(':') ? op.split(':').slice(1).join(':') : op;
  const fn = OPS[key];
  if (!fn) throw new Error(`working-memory-actuator: unknown op "${op}"`);
  return fn(params);
}

export interface HandleActionInput {
  action: string;
  steps?: Array<{ type?: string; op: string; params?: Record<string, unknown> }>;
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;
  options?: Record<string, unknown>;
  pipelineTrace?: unknown;
}

/**
 * Primary dispatch entry-point consumed by run_pipeline.ts.
 * Supports both pipeline-style (action='pipeline', steps=[{op, params}]) and
 * direct invocation (action='working-memory:daily-open', params={...}).
 */
export async function handleAction(input: HandleActionInput): Promise<Record<string, unknown>> {
  if (input.action === 'pipeline' && Array.isArray(input.steps) && input.steps.length > 0) {
    const step = input.steps[0];
    const result = dispatchOp(step.op, step.params ?? {});
    const exportAs = ((step.params ?? {}).export_as as string) ?? 'working_memory_result';
    return { ...(input.context ?? {}), [exportAs]: result };
  }
  const params = input.params ?? {};
  const result = dispatchOp(input.action, params);
  const exportAs = (params.export_as as string) ?? 'working_memory_result';
  return { ...(input.context ?? {}), [exportAs]: result };
}
