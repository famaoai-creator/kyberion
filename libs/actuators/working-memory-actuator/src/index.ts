/**
 * working-memory-actuator
 * Volatile Knowledge Layer — CRUD + GC + index for working-memory faces.
 *
 * Dispatch: exported handleAction() satisfies run_pipeline.ts dispatch contract.
 * Invariant: all file I/O uses @agent/core secure-io (never node:fs directly).
 */

import * as path from 'node:path';
import { pathResolver, type VolatileScope } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeLstat,
  safeWriteFile,
  safeReaddir,
} from '@agent/core/secure-io';
import { nowIso, parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import {
  loadVolatileSidecarAtPath,
  parseVolatileSidecar as parseCanonicalVolatileSidecar,
  saveVolatileSidecarAtPath,
  volatileSidecarPath as canonicalVolatileSidecarPath,
  type VolatileLifetime,
  type VolatileSidecar,
  type VolatileTier,
} from '@agent/core/volatile-knowledge';
import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateTier,
} from '@agent/core/memory-promotion-queue';
import {
  boundNotebook,
  bullets as notebookBullets,
  bulletsBelowMarker,
  DEFAULT_CONSOLIDATE_AFTER,
  foldCapture,
  normalize as normalizeBullet,
} from '@agent/core/memory-notebook';
const pr = pathResolver;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const actuator = defineCatalogBackedActuator({
  id: 'working-memory-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SCHEMA_REF = '../../../knowledge/product/schemas/volatile-knowledge.schema.json';

function parseVolatileIndex(
  value: unknown
): Array<{ mdPath: string; sidecar: VolatileSidecar }> | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((candidate) => {
    try {
      const record = parseSafeJsonObjectValue(candidate, 'volatile knowledge index entry');
      if (!Object.keys(record).every((key) => key === 'mdPath' || key === 'sidecar')) return null;
      const mdPath =
        typeof record.mdPath === 'string' && record.mdPath.trim().length > 0 ? record.mdPath : null;
      const sidecar = parseCanonicalVolatileSidecar(record.sidecar);
      return mdPath && sidecar ? { mdPath, sidecar } : null;
    } catch {
      return null;
    }
  });
  return entries.some((entry) => entry === null)
    ? null
    : (entries as Array<{ mdPath: string; sidecar: VolatileSidecar }>);
}

function isoDate(): string {
  return nowIso().slice(0, 10);
}

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
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilSunday, 23, 59, 59, 999)
  );
  return new Date(end.getTime() + 8 * 7 * 24 * 3600 * 1000).toISOString();
}

function ensureDir(dir: string): void {
  const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDir)) safeMkdir(safeDir, { recursive: true });
}

function sidecarPath(mdPath: string): string {
  return canonicalVolatileSidecarPath(mdPath);
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeDailyPeriod(value: unknown): string {
  const date = String(value ?? isoDate()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`[working-memory] invalid daily period '${date}'`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`[working-memory] invalid daily period '${date}'`);
  }
  return date;
}

function normalizeWeeklyPeriod(value: unknown): string {
  const week = String(value ?? isoWeek()).trim();
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(week)) {
    throw new Error(`[working-memory] invalid weekly period '${week}'`);
  }
  return week;
}

function loadSidecar(mdPath: string): VolatileSidecar | null {
  const sp = sidecarPath(mdPath);
  if (!isExistingRegularFile(sp)) return null;
  return loadVolatileSidecarAtPath(sp);
}

function saveSidecar(mdPath: string, sidecar: VolatileSidecar): VolatileSidecar {
  const sp = sidecarPath(mdPath);
  ensureDir(path.dirname(sp));
  try {
    return saveVolatileSidecarAtPath(sp, sidecar);
  } catch {
    throw new Error('[working-memory] refusing to persist an invalid sidecar');
  }
}

function touchSidecar(mdPath: string, patch: Partial<VolatileSidecar>): VolatileSidecar {
  const persistedPath = sidecarPath(mdPath);
  const existing = loadSidecar(mdPath);
  if (isExistingRegularFile(persistedPath) && !existing) {
    throw new Error('[working-memory] refusing to update an invalid sidecar');
  }
  const now = nowIso();
  const merged = { ...existing, ...patch, updated_at: now } as VolatileSidecar;
  if (!merged.created_at) merged.created_at = now;
  return saveSidecar(mdPath, merged);
}

function scopeDefaultTier(scope: VolatileScope): VolatileTier {
  return scope === 'personal' ? 'personal' : 'confidential';
}

function scopeDefaultLifetime(scope: VolatileScope): VolatileLifetime {
  switch (scope) {
    case 'session':
      return 'session';
    case 'mission':
      return 'mission';
    default:
      return 'until-distilled';
  }
}

function residentSidecarPatch(
  scope: VolatileScope,
  scopeRef: string | null,
  tier: VolatileTier
): Partial<VolatileSidecar> {
  return {
    $schema: SCHEMA_REF,
    scope,
    scope_ref: scopeRef,
    cadence: 'resident',
    period_key: null,
    tier,
    lifetime: scopeDefaultLifetime(scope),
    expires_at: null,
    rollover_to: null,
    rollup_to: null,
    promote_target: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  };
}

function dailySidecarPatch(dateStr: string): Partial<VolatileSidecar> {
  return {
    $schema: SCHEMA_REF,
    scope: 'personal',
    scope_ref: null,
    cadence: 'daily',
    period_key: dateStr,
    tier: 'personal',
    lifetime: 'daily',
    expires_at: dailyExpiry(dateStr),
    rollover_to: null,
    rollup_to: null,
    promote_target: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  };
}

function personalDir(): string {
  const d = pr.active('personal');
  ensureDir(d);
  return d;
}

/**
 * Resolve an externally supplied volatile-face path without allowing a
 * caller to turn this actuator into a general repository reader/writer.
 * `allowMissingLeaf` is intentional for read and nomination paths: the
 * operation owns the user-facing not-found result, while every existing
 * component is still checked for symlink traversal.
 */
function resolveVolatilePath(value: unknown, label: string): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  const resolved = assertSafeRepositoryPath(requested, { allowMissingLeaf: true });
  const activeRoot = assertSafeRepositoryPath(pr.active(), { allowMissingLeaf: true });
  if (resolved !== activeRoot && !resolved.startsWith(`${activeRoot}${path.sep}`)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] ${label} must stay under active/`);
  }
  return resolved;
}

function consolidationStatus(
  mdPath: string,
  body?: string
): {
  due: boolean;
  bullet_count: number;
  threshold: number;
} {
  const content =
    body ??
    (isExistingRegularFile(mdPath) ? String(safeReadFile(mdPath, { encoding: 'utf8' })) : '');
  const bulletCount = bulletsBelowMarker(content);
  return {
    due: bulletCount >= DEFAULT_CONSOLIDATE_AFTER,
    bullet_count: bulletCount,
    threshold: DEFAULT_CONSOLIDATE_AFTER,
  };
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
  // QM-03: notes follow the memory-notebook fold — untrusted provenance is
  // neutralized, duplicates (by normalized text) are dropped, and the new
  // bullet carries a capture date. `trusted: true` marks operator-authored
  // notes whose provenance suffixes are kept verbatim.
  const trusted = params.trusted === true;
  const rawContent = String(params.content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*]\s+/, '');

  const foldedContent = foldCapture('', [rawContent], Date.now(), trusted);
  const content = notebookBullets(foldedContent.body)[0] || '';

  const dir = pr.volatile(scope, scopeRef, { tier });
  ensureDir(dir);
  const mdPath = path.join(dir, 'MEMORY.md');
  if (!isExistingRegularFile(mdPath)) safeWriteFile(mdPath, memoryTemplate('Working Memory'));

  const existing = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
  const fullSidecarPatch: Partial<VolatileSidecar> = {
    $schema: SCHEMA_REF,
    scope,
    scope_ref: scopeRef,
    cadence: 'resident',
    period_key: null,
    tier,
    lifetime: scopeDefaultLifetime(scope),
    expires_at: null,
    rollover_to: null,
    rollup_to: null,
    promote_target: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  };

  const seen = new Set(notebookBullets(existing).map(normalizeBullet));
  if (!content || seen.has(normalizeBullet(content))) {
    // Deduped no-op: the .md was not touched, so only bump updated_at —
    // never reset promotion state the way a full sidecar patch would. A
    // first-ever touch (no sidecar yet) still gets the full shape so GC and
    // the index never see a bare {updated_at} sidecar.
    const sidecarUnchanged = loadSidecar(mdPath)
      ? touchSidecar(mdPath, { updated_at: nowIso() })
      : touchSidecar(mdPath, fullSidecarPatch);
    return {
      path: mdPath,
      sidecar: sidecarUnchanged,
      deduped: true,
      consolidation: consolidationStatus(mdPath, existing),
    };
  }

  const bullet = `- ${content}`;
  const target = `## ${section}`;
  const idx = existing.indexOf(target);
  let updated: string;
  if (idx >= 0) {
    const sectionStart = existing.indexOf('\n', idx) + 1;
    const nextSection = existing.indexOf('\n## ', sectionStart);
    const sectionEnd = nextSection >= 0 ? nextSection : existing.length;
    const sectionBody = existing.slice(sectionStart, sectionEnd).trimEnd();
    const prefix = existing.slice(0, sectionStart);
    const suffix = existing.slice(sectionEnd);
    updated = `${prefix}${sectionBody ? `${sectionBody}\n` : ''}${bullet}\n${suffix}`;
  } else {
    updated = existing.trimEnd() + `\n\n## ${section}\n\n${bullet}\n`;
  }

  const bounded = boundNotebook(updated);
  safeWriteFile(mdPath, bounded);
  const sidecar = touchSidecar(mdPath, fullSidecarPatch);
  return { path: mdPath, sidecar, consolidation: consolidationStatus(mdPath, bounded) };
}

function opSetNow(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);

  const dir = pr.volatile(scope, scopeRef, { tier });
  ensureDir(dir);
  const mdPath = path.join(dir, 'NOW.md');
  const text = [
    '# NOW',
    '',
    `> Updated: ${nowIso()}`,
    '',
    '## Current Focus',
    '',
    String(params.focus ?? ''),
    '',
    '## Next Action',
    '',
    String(params.nextAction ?? ''),
    '',
    '## Context',
    '',
    String(params.context ?? ''),
    '',
  ].join('\n');
  safeWriteFile(mdPath, text);
  const sidecar = touchSidecar(mdPath, {
    $schema: SCHEMA_REF,
    scope,
    scope_ref: scopeRef,
    cadence: 'resident',
    period_key: null,
    tier,
    lifetime: scopeDefaultLifetime(scope),
    expires_at: null,
    rollover_to: null,
    rollup_to: null,
    promote_target: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
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
  if (!isExistingRegularFile(mdPath)) safeWriteFile(mdPath, memoryTemplate('Working Memory'));

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
  touchSidecar(mdPath, {
    ...(loadSidecar(mdPath) ? {} : residentSidecarPatch(scope, scopeRef, tier)),
    updated_at: nowIso(),
    status: 'active',
  });
  return { path: mdPath };
}

function opCompleteActionItem(params: Record<string, unknown>): unknown {
  const scope = (params.scope as VolatileScope) ?? 'global';
  const scopeRef = (params.scope_ref as string) ?? null;
  const tier = (params.tier as VolatileTier) ?? scopeDefaultTier(scope);
  const item = String(params.item ?? '');

  const dir = pr.volatile(scope, scopeRef, { tier });
  const mdPath = path.join(dir, 'MEMORY.md');
  if (!isExistingRegularFile(mdPath)) return { path: mdPath, found: false };

  const existing = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
  // Anchored end-of-line (^…$, multiline) prevents "Buy milk" matching "Buy milk chocolate"
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^- \\[ \\] ${escaped}$`, 'gm').test(existing))
    return { path: mdPath, found: false };
  const updated = existing.replace(new RegExp(`^(- \\[ \\] ${escaped})$`, 'gm'), `- [x] ${item}`);
  safeWriteFile(mdPath, updated);
  touchSidecar(mdPath, {
    ...(loadSidecar(mdPath) ? {} : residentSidecarPatch(scope, scopeRef, tier)),
    updated_at: nowIso(),
  });
  return { path: mdPath, found: true };
}

function opDailyOpen(params: Record<string, unknown>): unknown {
  const dateStr = normalizeDailyPeriod(params.date);
  const pDir = personalDir();
  const journalDir = path.join(pDir, 'journal');
  const todayDir = path.join(pDir, 'today');
  const weeklyDir = path.join(pDir, 'weekly');
  ensureDir(journalDir);
  ensureDir(todayDir);
  ensureDir(weeklyDir);

  const journalPath = assertSafeRepositoryPath(path.join(journalDir, `${dateStr}.md`), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(journalPath)) safeWriteFile(journalPath, dailyJournalTemplate(dateStr));

  const weekKey = isoWeek(new Date(`${dateStr}T12:00:00Z`));
  const journalSidecar = touchSidecar(journalPath, {
    $schema: SCHEMA_REF,
    scope: 'personal',
    scope_ref: null,
    cadence: 'daily',
    period_key: dateStr,
    tier: 'personal',
    lifetime: 'daily',
    expires_at: dailyExpiry(dateStr),
    rollover_to: null,
    rollup_to: path.join(weeklyDir, `${weekKey}.md`),
    promote_target: 'knowledge/product/governance/HINTS.md',
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  });

  const todoPath = assertSafeRepositoryPath(path.join(todayDir, 'TODO.md'), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(todoPath)) safeWriteFile(todoPath, todoTemplate(dateStr));
  const todoSidecar = touchSidecar(todoPath, {
    $schema: SCHEMA_REF,
    scope: 'personal',
    scope_ref: null,
    cadence: 'daily',
    period_key: dateStr,
    tier: 'personal',
    lifetime: 'daily',
    expires_at: dailyExpiry(dateStr),
    rollover_to: journalPath,
    rollup_to: null,
    promote_target: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  });

  return { journalPath, todoPath, journalSidecar, todoSidecar };
}

function opTodoAdd(params: Record<string, unknown>): unknown {
  const dateStr = (params.date as string) ?? isoDate();
  const item = String(params.item ?? '');
  const result = opDailyOpen({ date: dateStr }) as { todoPath: string };
  const existing = isExistingRegularFile(result.todoPath)
    ? (safeReadFile(result.todoPath, { encoding: 'utf8' }) as string)
    : '';
  safeWriteFile(result.todoPath, existing.trimEnd() + `\n- [ ] ${item}\n`);
  touchSidecar(result.todoPath, { updated_at: nowIso() });
  return { path: result.todoPath };
}

function opTodoDone(params: Record<string, unknown>): unknown {
  const dateStr = normalizeDailyPeriod(params.date);
  const item = String(params.item ?? '');
  const pDir = pr.active('personal');
  const todoPath = assertSafeRepositoryPath(path.join(pDir, 'today', 'TODO.md'), {
    allowMissingLeaf: true,
  });
  if (!isExistingRegularFile(todoPath)) return { path: todoPath, found: false };

  const existing = safeReadFile(todoPath, { encoding: 'utf8' }) as string;
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^- \\[ \\] ${escaped}$`, 'gm').test(existing))
    return { path: todoPath, found: false };
  safeWriteFile(
    todoPath,
    existing.replace(new RegExp(`^(- \\[ \\] ${escaped})$`, 'gm'), `- [x] ${item}`)
  );

  const journalPath = assertSafeRepositoryPath(path.join(pDir, 'journal', `${dateStr}.md`), {
    allowMissingLeaf: true,
  });
  if (isExistingRegularFile(journalPath)) {
    const j = safeReadFile(journalPath, { encoding: 'utf8' }) as string;
    const doneIdx = j.indexOf('## Done');
    if (doneIdx >= 0) {
      const ins = j.indexOf('\n', doneIdx) + 1;
      safeWriteFile(journalPath, j.slice(0, ins) + `\n- [x] ${item}\n` + j.slice(ins));
    }
  }
  touchSidecar(todoPath, {
    ...(loadSidecar(todoPath) ? {} : { ...dailySidecarPatch(dateStr), period_key: dateStr }),
    updated_at: nowIso(),
  });
  return { path: todoPath, found: true };
}

function opTodoRollover(params: Record<string, unknown>): unknown {
  const todayStr = normalizeDailyPeriod(params.date);
  const pDir = pr.active('personal');
  const journalDir = path.join(pDir, 'journal');
  const todoPath = assertSafeRepositoryPath(path.join(pDir, 'today', 'TODO.md'), {
    allowMissingLeaf: true,
  });

  if (!isExistingRegularFile(todoPath)) return { rolledOver: 0, items: [] };

  const existing = safeReadFile(todoPath, { encoding: 'utf8' }) as string;
  const pendingLines = existing.split('\n').filter((l) => /^- \[ \] /.test(l));
  if (pendingLines.length === 0) {
    touchSidecar(todoPath, {
      ...(loadSidecar(todoPath) ? {} : dailySidecarPatch(todayStr)),
      status: 'rolled-over',
    });
    return { rolledOver: 0, items: [] };
  }

  // Append pending items to today's journal
  const journalPath = assertSafeRepositoryPath(path.join(journalDir, `${todayStr}.md`), {
    allowMissingLeaf: true,
  });
  if (isExistingRegularFile(journalPath)) {
    const j = safeReadFile(journalPath, { encoding: 'utf8' }) as string;
    const todoIdx = j.indexOf('## TODO');
    if (todoIdx >= 0) {
      const ins = j.indexOf('\n', todoIdx) + 1;
      safeWriteFile(
        journalPath,
        j.slice(0, ins) + '\n' + pendingLines.join('\n') + '\n' + j.slice(ins)
      );
    }
  }

  // Rewrite TODO for next day
  const nextDay = new Date(`${todayStr}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  safeWriteFile(todoPath, todoTemplate(nextDayStr) + pendingLines.join('\n') + '\n');
  touchSidecar(todoPath, {
    ...(loadSidecar(todoPath) ? {} : dailySidecarPatch(nextDayStr)),
    status: 'rolled-over',
    period_key: nextDayStr,
    updated_at: nowIso(),
  });

  return {
    rolledOver: pendingLines.length,
    items: pendingLines.map((l) => l.replace(/^- \[ \] /, '')),
  };
}

function opWeeklyOpen(params: Record<string, unknown>): unknown {
  const weekKey = normalizeWeeklyPeriod(params.weekKey);
  const pDir = personalDir();
  const weeklyDir = path.join(pDir, 'weekly');
  const journalDir = path.join(pDir, 'journal');
  ensureDir(weeklyDir);
  ensureDir(journalDir);

  const weeklyPath = assertSafeRepositoryPath(path.join(weeklyDir, `${weekKey}.md`), {
    allowMissingLeaf: true,
  });
  const dailyPaths: string[] = [];
  try {
    for (const entry of safeReaddir(journalDir)) {
      if (entry.endsWith('.md')) dailyPaths.push(path.join(journalDir, entry));
    }
  } catch {
    /* journal dir may not exist yet */
  }

  if (!safeExistsSync(weeklyPath)) {
    const linkLines = dailyPaths.map((p) => `- [${path.basename(p)}](${p})`).join('\n');
    safeWriteFile(weeklyPath, weeklyTemplate(weekKey) + (linkLines ? linkLines + '\n' : ''));
  }

  const sidecar = touchSidecar(weeklyPath, {
    $schema: SCHEMA_REF,
    scope: 'personal',
    scope_ref: null,
    cadence: 'weekly',
    period_key: weekKey,
    tier: 'personal',
    lifetime: 'weekly',
    expires_at: weeklyExpiry(),
    rollover_to: null,
    rollup_to: null,
    promote_target: 'knowledge/product/governance/HINTS.md',
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  });

  return { weeklyPath, sidecar, dailyPaths };
}

function opNominatePromotion(params: Record<string, unknown>): unknown {
  const mdPath = params.mdPath ? resolveVolatilePath(params.mdPath, 'mdPath') : '';
  const sourceRef = String(params.source_ref ?? (mdPath || 'volatile-face'));
  const summary = String(
    params.summary ?? 'Distillation candidate from volatile working-memory face'
  );
  const sourceType =
    (params.source_type as 'mission' | 'task_session' | 'artifact' | 'incident') ?? 'task_session';
  const proposedKind = (params.proposed_memory_kind as MemoryCandidateKind) ?? 'heuristic';
  const sensitivityTier = (params.sensitivity_tier as MemoryCandidateTier) ?? 'personal';
  const evidenceRefs: string[] = Array.isArray(params.evidence_refs)
    ? (params.evidence_refs as string[])
    : mdPath
      ? [mdPath]
      : [];

  if (evidenceRefs.length === 0) return { nominated: false, reason: 'no evidence_refs' };

  const candidate = createMemoryPromotionCandidate({
    sourceType,
    sourceRef,
    proposedMemoryKind: proposedKind,
    summary,
    evidenceRefs,
    sensitivityTier,
    ratificationRequired: sensitivityTier !== 'personal',
  });
  enqueueMemoryPromotionCandidate(candidate);

  if (mdPath && isExistingRegularFile(mdPath)) {
    touchSidecar(mdPath, { promotion_candidate_id: candidate.candidate_id, status: 'promoted' });
  }

  return { nominated: true, candidateId: candidate.candidate_id };
}

function opRead(params: Record<string, unknown>): unknown {
  const mdPath = resolveVolatilePath(params.mdPath, 'mdPath');
  const content = isExistingRegularFile(mdPath)
    ? (safeReadFile(mdPath, { encoding: 'utf8' }) as string)
    : null;
  return { content, sidecar: loadSidecar(mdPath) };
}

function opConsolidationStatus(params: Record<string, unknown>): unknown {
  const mdPath = params.mdPath
    ? resolveVolatilePath(params.mdPath, 'mdPath')
    : path.join(pr.active('personal'), 'MEMORY.md');
  return { path: mdPath, ...consolidationStatus(mdPath) };
}

function opList(params: Record<string, unknown>): unknown {
  const indexPath = assertSafeRepositoryPath(pr.active('INDEX.volatile.json'), {
    allowMissingLeaf: true,
  });
  if (!isExistingRegularFile(indexPath)) return [];
  try {
    const all = parseVolatileIndex(
      parseSafeJsonInput(
        String(safeReadFile(indexPath, { encoding: 'utf8' }) || ''),
        'volatile knowledge index'
      )
    );
    if (!all) return [];
    return all.filter((entry) => {
      if (params.scope && entry.sidecar.scope !== params.scope) return false;
      if (params.cadence && entry.sidecar.cadence !== params.cadence) return false;
      if (params.status && entry.sidecar.status !== params.status) return false;
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Full GC pass: scans all *.volatile.json under active/, enforces lifetime policies.
 * Replaces the three-script approach; all logic is inline and auditable here.
 */
function opRunGc(params: Record<string, unknown>): unknown {
  const activeRoot = pr.active();
  const now = nowIso();
  const results = { expired: 0, rolledOver: 0, warnings: [] as string[] };

  function scanDir(dir: string): void {
    if (!safeExistsSync(dir)) return;
    try {
      if (!safeLstat(dir).isDirectory()) return;
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = safeReaddir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      let fullPath: string;
      try {
        fullPath = assertSafeRepositoryPath(path.join(dir, entry), {
          allowMissingLeaf: true,
        });
      } catch {
        results.warnings.push(`unsafe sidecar path skipped: ${path.join(dir, entry)}`);
        continue;
      }
      if (entry.endsWith('.volatile.json')) {
        if (!isExistingRegularFile(fullPath)) continue;
        let sidecar: VolatileSidecar | null;
        try {
          sidecar = loadVolatileSidecarAtPath(fullPath);
        } catch {
          results.warnings.push(`malformed sidecar skipped: ${fullPath}`);
          continue;
        }
        if (!sidecar) {
          results.warnings.push(`malformed sidecar skipped: ${fullPath}`);
          continue;
        }
        if (sidecar.status === 'archived' || sidecar.status === 'promoted') continue;
        if (sidecar.expires_at && sidecar.expires_at < now && !sidecar.pinned) {
          try {
            safeWriteFile(
              fullPath,
              JSON.stringify({ ...sidecar, status: 'expired', updated_at: now }, null, 2)
            );
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
  } catch {
    /* no personal dir yet */
  }

  return results;
}

/**
 * Build active/INDEX.volatile.{md,json}. Replaces volatile_index_build.js.
 */
function opBuildIndex(_params: Record<string, unknown>): unknown {
  const activeRoot = pr.active();
  const faces: Array<{ mdPath: string; sidecar: VolatileSidecar }> = [];

  function scanDir(dir: string): void {
    if (!safeExistsSync(dir)) return;
    try {
      if (!safeLstat(dir).isDirectory()) return;
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = safeReaddir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      let fullPath: string;
      try {
        fullPath = assertSafeRepositoryPath(path.join(dir, entry), {
          allowMissingLeaf: true,
        });
      } catch {
        continue;
      }
      if (entry.endsWith('.volatile.json')) {
        if (!isExistingRegularFile(fullPath)) continue;
        try {
          const sidecar = loadVolatileSidecarAtPath(fullPath);
          if (!sidecar) continue;
          faces.push({ mdPath: fullPath.replace(/\.volatile\.json$/, '.md'), sidecar });
        } catch {
          /* skip */
        }
      } else if (!entry.includes('.')) {
        if (!fullPath.includes(`${path.sep}archive${path.sep}`)) scanDir(fullPath);
      }
    }
  }

  scanDir(activeRoot);
  faces.sort(
    (a, b) => a.sidecar.scope.localeCompare(b.sidecar.scope) || a.mdPath.localeCompare(b.mdPath)
  );

  const jsonPath = assertSafeRepositoryPath(pr.active('INDEX.volatile.json'), {
    allowMissingLeaf: true,
  });
  const mdIndexPath = assertSafeRepositoryPath(pr.active('INDEX.volatile.md'), {
    allowMissingLeaf: true,
  });
  const relPath = (p: string) =>
    p.startsWith(activeRoot) ? 'active' + p.slice(activeRoot.length) : p;
  const rows = faces
    .map(
      (f) =>
        `| ${relPath(f.mdPath)} | ${f.sidecar.scope} | ${f.sidecar.cadence} | ${f.sidecar.lifetime} | ${f.sidecar.expires_at ?? '—'} | ${f.sidecar.status} |`
    )
    .join('\n');
  const mdContent = [
    '# Volatile Knowledge Index',
    '',
    '> **Generated** — non-SSoT. Source of truth: individual `*.volatile.json` sidecars.',
    '> Run `pnpm pipeline --input pipelines/volatile-index.json` to refresh.',
    '',
    '| Path | Scope | Cadence | Lifetime | Expires | Status |',
    '|---|---|---|---|---|---|',
    rows,
    '',
  ].join('\n');

  safeWriteFile(jsonPath, JSON.stringify(faces, null, 2));
  safeWriteFile(mdIndexPath, mdContent);

  return { count: faces.length, jsonPath, mdIndexPath };
}

// ---------------------------------------------------------------------------
// initMissionMemory — called from mission-creation.ts on new mission creation
// ---------------------------------------------------------------------------

export function initMissionMemory(input: { missionId: string; tier?: VolatileTier }): {
  mdPath: string;
  nowPath: string;
} {
  const dir = pr.volatile('mission', input.missionId, { tier: input.tier ?? 'confidential' });
  const mdPath = assertSafeRepositoryPath(path.join(dir, 'MEMORY.md'), {
    allowMissingLeaf: true,
  });
  const nowPath = assertSafeRepositoryPath(path.join(dir, 'NOW.md'), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(mdPath))
    safeWriteFile(mdPath, memoryTemplate(`Mission ${input.missionId} — Working Memory`));
  if (!safeExistsSync(nowPath)) safeWriteFile(nowPath, nowTemplate());
  const baseSidecar: Partial<VolatileSidecar> = {
    $schema: SCHEMA_REF,
    scope: 'mission',
    scope_ref: input.missionId,
    cadence: 'resident',
    period_key: null,
    tier: input.tier ?? 'confidential',
    lifetime: 'mission',
    expires_at: null,
    rollover_to: null,
    rollup_to: null,
    promotion_candidate_id: null,
    status: 'active',
    pinned: false,
  };
  touchSidecar(mdPath, { ...baseSidecar, promote_target: 'knowledge/product/governance/HINTS.md' });
  touchSidecar(nowPath, { ...baseSidecar, promote_target: null });
  return { mdPath, nowPath };
}

// ---------------------------------------------------------------------------
// Dispatch table & handleAction export
// ---------------------------------------------------------------------------

const OPS: Record<string, (params: Record<string, unknown>) => unknown> = {
  note: opNote,
  'set-now': opSetNow,
  'add-action-item': opAddActionItem,
  'complete-action-item': opCompleteActionItem,
  'daily-open': opDailyOpen,
  'todo-add': opTodoAdd,
  'todo-done': opTodoDone,
  'todo-rollover': opTodoRollover,
  'weekly-open': opWeeklyOpen,
  'nominate-promotion': opNominatePromotion,
  'consolidation-status': opConsolidationStatus,
  'run-gc': opRunGc,
  'build-index': opBuildIndex,
  read: opRead,
  list: opList,
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
    ensureDefaultOpPreflight();
    const preflight = await runOpPreflight({
      op: `working-memory:${step.op}`,
      params: step.params ?? {},
      context: input.context,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation working-memory:${step.op} was not admitted.`}`
      );
    }
    const result = dispatchOp(step.op, preflight.input);
    const exportAs = (preflight.input.export_as as string) ?? 'working_memory_result';
    return { ...(input.context ?? {}), [exportAs]: result };
  }
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `working-memory:${input.action}`,
    params: input.params ?? {},
    context: input.context,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation working-memory:${input.action} was not admitted.`}`
    );
  }
  const params = preflight.input;
  const result = dispatchOp(input.action, params);
  const exportAs = (params.export_as as string) ?? 'working_memory_result';
  return { ...(input.context ?? {}), [exportAs]: result };
}
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
