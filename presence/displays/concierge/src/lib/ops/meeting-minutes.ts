import path from 'node:path';

import { readJson } from '@agent/core/foundation';
import { pathResolver, toRepoRelative } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import { loadStateAtPath } from '@agent/core/mission/mission-state';

/**
 * Scoped meeting-minutes index for Concierge.
 *
 * Three governed sources, all already produced elsewhere (this module only
 * reads):
 *   - mission   — `active/missions/<tier>/…/<id>/evidence/minutes.md` written by
 *                 the meeting-followup pipeline (`pnpm minutes:record`)
 *   - pad       — meeting-notepad pad records under
 *                 `active/shared/local-pads/<tier>/<tenant>/…/meeting-notepad/`
 *   - notepad   — meeting-notepad session outputs (`minutes.md`/`minutes.json` +
 *                 `handoff.json`) under `active/shared/` outside the pad store
 *
 * Visibility mirrors the producers: mission items follow the mission state's
 * tier + tenant; pad records follow the pad record's own scope + the
 * personal-tier principal rule (isPadRecordVisible); loose notepad sessions are
 * shared-runtime output and follow their recorded scope when one exists.
 */

export type MinutesSource = 'mission' | 'pad' | 'notepad';
export type MinutesTier = 'personal' | 'confidential' | 'public';

/**
 * Read-side projection of scripts/personal-pads/storage.ts `PadRecordLite` — only
 * the fields this index consumes. Declared locally so the display package
 * never reaches into the pads implementation.
 */
export interface PadRecordLite {
  record_id: string;
  pad_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  viewer_principal: string;
  scope?: {
    scope_kind?: string;
    tier?: string;
    tenant_slug?: string;
    organization_id?: string;
    project_id?: string;
    mission_id?: string;
    task_id?: string;
    session_id?: string;
  };
  tier: string;
  payload?: Readonly<Record<string, string>>;
}

export interface MinutesScope {
  tierAccess: readonly MinutesTier[];
  tenantSlugs: readonly string[] | 'all';
  /** Server-resolved only: also admit records carrying no tenant. */
  includeUntenanted?: boolean;
  /** Required to see personal-tier pad records (record.viewer_principal match). */
  viewerPrincipal?: string;
  organizationIds?: readonly string[] | 'all';
  projectIds?: readonly string[] | 'all';
}

export interface MinutesItem {
  /** Stable address for /api/ops/minutes/content: `${source}:${key}`. */
  id: string;
  source: MinutesSource;
  key: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  tier?: MinutesTier;
  tenantSlug?: string;
  missionId?: string;
  /** Repo-relative file when the minutes live on disk (mission/notepad). */
  path?: string;
  summary?: string;
}

export interface MinutesContent {
  id: string;
  source: MinutesSource;
  title: string;
  createdAt?: string;
  missionId?: string;
  tenantSlug?: string;
  tier?: MinutesTier;
  /** The minutes document (markdown when available). */
  content: string;
  /** Extra documents the same record carries (transcript, action items). */
  attachments?: Array<{ label: string; content: string }>;
  path?: string;
}

const PAD_ID = 'meeting-notepad';
const MINUTES_FILE = 'minutes.md';
const TRANSCRIPT_FILE = 'transcript.md';
const MAX_NOTES_DEPTH = 8;
const MAX_ITEMS_PER_SOURCE = 400;

function tierOf(value: unknown): MinutesTier | undefined {
  return value === 'personal' || value === 'confidential' || value === 'public' ? value : undefined;
}

/** Pure scope admission — exported so the visibility rules are testable without fixture trees. */
export function scopeAdmits(
  scope: MinutesScope,
  entry: { tier?: string; tenantSlug?: string }
): boolean {
  if (entry.tier && !scope.tierAccess.includes(entry.tier as MinutesTier)) return false;
  if (scope.tenantSlugs === 'all') return true;
  if (!entry.tenantSlug) return scope.includeUntenanted === true;
  return scope.tenantSlugs.includes(entry.tenantSlug);
}

// ---------------------------------------------------------------------------
// Source 1: mission evidence
// ---------------------------------------------------------------------------

interface MissionDirHit {
  missionId: string;
  evidenceDir: string;
  statePath?: string;
}

function collectMissionDirs(root: string, depth = 0): MissionDirHit[] {
  if (depth > 2 || !safeExistsSync(root) || !safeLstat(root).isDirectory()) return [];
  const hits: MissionDirHit[] = [];
  for (const entry of safeReaddir(root)) {
    const dir = path.join(root, entry);
    let stat;
    try {
      stat = safeLstat(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const evidenceDir = path.join(dir, 'evidence');
    const statePath = path.join(dir, 'mission-state.json');
    if (safeExistsSync(evidenceDir) && safeLstat(evidenceDir).isDirectory()) {
      hits.push({
        missionId: entry,
        evidenceDir,
        statePath: safeExistsSync(statePath) ? statePath : undefined,
      });
    } else {
      // Tenant partition: missions/<tier>/<tenant>/<id>/evidence.
      hits.push(...collectMissionDirs(dir, depth + 1));
    }
  }
  return hits;
}

function collectMissionMinutes(scope: MinutesScope): MinutesItem[] {
  const items: MinutesItem[] = [];
  for (const tier of scope.tierAccess) {
    const tierRoot = pathResolver.active(path.join('missions', tier));
    let safeRoot: string;
    try {
      safeRoot = assertSafeRepositoryPath(tierRoot, { allowMissingLeaf: true });
    } catch {
      continue;
    }
    for (const hit of collectMissionDirs(safeRoot)) {
      if (items.length >= MAX_ITEMS_PER_SOURCE) return items;
      const minutesPath = path.join(hit.evidenceDir, MINUTES_FILE);
      if (!safeExistsSync(minutesPath) || !safeLstat(minutesPath).isFile()) continue;
      let tenantSlug: string | undefined;
      let title = hit.missionId;
      let organizationId: string | undefined;
      let projectId: string | undefined;
      if (hit.statePath) {
        const state = loadStateAtPath(hit.statePath);
        tenantSlug = state?.tenant_slug || state?.tenant_id;
        organizationId = state?.relationships?.organization?.organization_id;
        projectId = state?.relationships?.project?.project_id;
        // MissionState carries no display title; the agreed goal is the
        // human-readable name (same projection as su-surface-data.ts).
        if (state?.intent?.goal_summary) title = state.intent.goal_summary;
      }
      if (
        !scopeAdmits(scope, { tier, tenantSlug }) ||
        (scope.organizationIds &&
          scope.organizationIds !== 'all' &&
          !scope.organizationIds.includes(organizationId ?? '')) ||
        (scope.projectIds &&
          scope.projectIds !== 'all' &&
          !scope.projectIds.includes(projectId ?? ''))
      ) {
        continue;
      }
      const stat = safeLstat(minutesPath);
      items.push({
        id: `mission:${hit.missionId}`,
        source: 'mission',
        key: hit.missionId,
        title,
        createdAt: (stat.birthtime || stat.mtime || new Date()).toISOString(),
        updatedAt: (stat.mtime || new Date()).toISOString(),
        tier,
        ...(tenantSlug ? { tenantSlug } : {}),
        missionId: hit.missionId,
        path: toRepoRelative(minutesPath),
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Source 2: meeting-notepad pad records
// ---------------------------------------------------------------------------

function collectPadIndexFiles(dir: string, depth = 0, found: string[] = []): string[] {
  if (depth > MAX_NOTES_DEPTH || !safeExistsSync(dir)) return found;
  for (const name of safeReaddir(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = safeLstat(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (name === 'records' && path.basename(dir) === PAD_ID) {
      const index = path.join(full, 'index.json');
      if (safeExistsSync(index) && safeLstat(index).isFile()) found.push(index);
      continue;
    }
    collectPadIndexFiles(full, depth + 1, found);
  }
  return found;
}

/** The pad store's own visibility rule, kept as a pure read-side check. */
export function padRecordVisible(record: PadRecordLite, scope: MinutesScope): boolean {
  if (record.tier === 'personal' && record.viewer_principal !== scope.viewerPrincipal) {
    return false;
  }
  if (!scopeAdmits(scope, { tier: record.tier, tenantSlug: record.scope?.tenant_slug })) {
    return false;
  }
  if (
    scope.organizationIds &&
    scope.organizationIds !== 'all' &&
    record.scope?.organization_id !== undefined &&
    !scope.organizationIds.includes(record.scope.organization_id)
  ) {
    return false;
  }
  if (
    scope.projectIds &&
    scope.projectIds !== 'all' &&
    record.scope?.project_id !== undefined &&
    !scope.projectIds.includes(record.scope.project_id)
  ) {
    return false;
  }
  return true;
}

function collectPadMinutes(scope: MinutesScope): MinutesItem[] {
  const padsRoot = pathResolver.shared('local-pads');
  let safeRoot: string;
  try {
    safeRoot = assertSafeRepositoryPath(padsRoot, { allowMissingLeaf: true });
  } catch {
    return [];
  }
  const items: MinutesItem[] = [];
  for (const index of collectPadIndexFiles(safeRoot)) {
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
    let records: PadRecordLite[];
    try {
      const parsed = readJson<unknown>(index);
      records = Array.isArray(parsed) ? (parsed as PadRecordLite[]) : [];
    } catch {
      continue;
    }
    for (const record of records) {
      if (items.length >= MAX_ITEMS_PER_SOURCE) break;
      if (record.pad_id !== PAD_ID || !padRecordVisible(record, scope)) continue;
      const summary = record.payload?.summary?.split('\n')[0]?.slice(0, 200) || undefined;
      items.push({
        id: `pad:${record.record_id}`,
        source: 'pad',
        key: record.record_id,
        title: record.title || 'Meeting minutes',
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        tier: tierOf(record.tier),
        ...(record.scope?.tenant_slug ? { tenantSlug: record.scope.tenant_slug } : {}),
        ...(record.scope?.mission_id ? { missionId: record.scope.mission_id } : {}),
        ...(summary ? { summary } : {}),
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Source 3: loose meeting-notepad session outputs
// ---------------------------------------------------------------------------

interface NotepadHandoff {
  title?: string;
  session_id?: string;
  created_at?: string;
  scope?: { tier?: string; tenant_slug?: string };
}

function readNotepadHandoff(dir: string): NotepadHandoff | undefined {
  const file = path.join(dir, 'handoff.json');
  if (!safeExistsSync(file) || !safeLstat(file).isFile()) return undefined;
  try {
    const parsed = readJson<unknown>(file);
    return parsed && typeof parsed === 'object' ? (parsed as NotepadHandoff) : undefined;
  } catch {
    return undefined;
  }
}

function collectNotepadMinutes(scope: MinutesScope): MinutesItem[] {
  const items: MinutesItem[] = [];
  const sharedRoot = assertSafeRepositoryPath(pathResolver.active('shared'), {
    allowMissingLeaf: true,
  });
  const roots = [path.join(sharedRoot, 'tmp'), path.join(sharedRoot, 'observability')];
  const pending: Array<{ dir: string; depth: number }> = roots.map((dir) => ({
    dir,
    depth: 0,
  }));
  while (pending.length && items.length < MAX_ITEMS_PER_SOURCE) {
    const { dir, depth } = pending.pop()!;
    if (depth > MAX_NOTES_DEPTH || !safeExistsSync(dir)) continue;
    let entries: string[];
    try {
      entries = safeReaddir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = safeLstat(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      // The pad store has its own scoped reader — never double-count it here.
      if (name === 'local-pads') continue;
      if (name === PAD_ID || name.startsWith(`${PAD_ID}-`) || name.startsWith(`${PAD_ID}_`)) {
        const minutesFile = path.join(full, MINUTES_FILE);
        if (safeExistsSync(minutesFile) && safeLstat(minutesFile).isFile()) {
          const handoff = readNotepadHandoff(full);
          const tier = tierOf(handoff?.scope?.tier) ?? 'public';
          const tenantSlug = handoff?.scope?.tenant_slug;
          if (scopeAdmits(scope, { tier, tenantSlug })) {
            const mstat = safeLstat(minutesFile);
            items.push({
              id: `notepad:${toRepoRelative(full)}`,
              source: 'notepad',
              key: toRepoRelative(full),
              title: handoff?.title || name,
              createdAt:
                handoff?.created_at || (mstat.birthtime || mstat.mtime || new Date()).toISOString(),
              updatedAt: (mstat.mtime || new Date()).toISOString(),
              tier,
              ...(tenantSlug ? { tenantSlug } : {}),
              path: toRepoRelative(minutesFile),
            });
          }
          continue;
        }
      }
      pending.push({ dir: full, depth: depth + 1 });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Combined index + content reads
// ---------------------------------------------------------------------------

export function listMeetingMinutes(scope: MinutesScope, limit = 100): MinutesItem[] {
  const items = [
    ...collectMissionMinutes(scope),
    ...collectPadMinutes(scope),
    ...collectNotepadMinutes(scope),
  ];
  return items
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

function readTextOrNull(file: string): string | null {
  try {
    if (!safeExistsSync(file) || !safeLstat(file).isFile()) return null;
    return String(safeReadFile(file));
  } catch {
    return null;
  }
}

function missionMinutesContent(missionId: string, scope: MinutesScope): MinutesContent | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(missionId)) return null;
  const item = collectMissionMinutes(scope).find((entry) => entry.missionId === missionId);
  if (!item?.path) return null;
  const file = assertSafeRepositoryPath(pathResolver.rootResolve(item.path));
  const content = readTextOrNull(file);
  if (content === null) return null;
  const transcript = readTextOrNull(path.join(path.dirname(file), TRANSCRIPT_FILE));
  return {
    ...item,
    content,
    attachments: transcript !== null ? [{ label: 'Transcript', content: transcript }] : [],
  };
}

function padMinutesContent(recordId: string, scope: MinutesScope): MinutesContent | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(recordId)) return null;
  const padsRoot = assertSafeRepositoryPath(pathResolver.shared('local-pads'), {
    allowMissingLeaf: true,
  });
  for (const index of collectPadIndexFiles(padsRoot)) {
    let records: PadRecordLite[];
    try {
      const parsed = readJson<unknown>(index);
      records = Array.isArray(parsed) ? (parsed as PadRecordLite[]) : [];
    } catch {
      continue;
    }
    const record = records.find((row) => row.record_id === recordId);
    if (!record || record.pad_id !== PAD_ID || !padRecordVisible(record, scope)) continue;
    const payload = record.payload || {};
    const sections: string[] = [];
    if (payload.summary) sections.push(`## Summary\n${payload.summary}`);
    if (payload.decisions) sections.push(`## Decisions\n${payload.decisions}`);
    if (payload.handoff) sections.push(`## Action items\n${payload.handoff}`);
    if (payload.open_questions) sections.push(`## Open questions\n${payload.open_questions}`);
    const body = record.body?.trim();
    const content = sections.length
      ? `# ${record.title || 'Meeting minutes'}\n\n${sections.join('\n\n')}`
      : body || '';
    if (!content) return null;
    return {
      id: `pad:${record.record_id}`,
      source: 'pad',
      title: record.title || 'Meeting minutes',
      createdAt: record.created_at,
      missionId: record.scope?.mission_id,
      tenantSlug: record.scope?.tenant_slug,
      tier: tierOf(record.tier),
      content,
      attachments: payload.minutes_markdown
        ? [{ label: 'Raw minutes', content: payload.minutes_markdown }]
        : [],
    };
  }
  return null;
}

function notepadMinutesContent(key: string, scope: MinutesScope): MinutesContent | null {
  const relative = key.replace(/\\/g, '/');
  if (
    relative.includes('..') ||
    !relative.startsWith('active/shared/') ||
    !relative.includes(PAD_ID)
  ) {
    return null;
  }
  const item = collectNotepadMinutes(scope).find((entry) => entry.key === relative);
  if (!item?.path) return null;
  const file = assertSafeRepositoryPath(pathResolver.rootResolve(item.path));
  const content = readTextOrNull(file);
  if (content === null) return null;
  const minutesJson = readTextOrNull(path.join(path.dirname(file), 'minutes.json'));
  return {
    ...item,
    content,
    attachments: minutesJson !== null ? [{ label: 'minutes.json', content: minutesJson }] : [],
  };
}

export function readMeetingMinutesContent(
  source: MinutesSource,
  key: string,
  scope: MinutesScope
): MinutesContent | null {
  if (source === 'mission') return missionMinutesContent(key, scope);
  if (source === 'pad') return padMinutesContent(key, scope);
  if (source === 'notepad') return notepadMinutesContent(key, scope);
  return null;
}
