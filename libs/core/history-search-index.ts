import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeReaddir,
  safeReadFile,
} from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import { readJsonLines } from './foundation/json.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { clamp, isRecord } from './foundation/text.js';
import { validateTraceReplay } from './trace-schema.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';

/**
 * HA-02: zero-LLM search over raw conversation and mission history.
 *
 * SQLite is invoked only through secure-io. The primary FTS5 index uses the
 * unicode61 tokenizer; the companion trigram index makes Japanese substring
 * queries useful without an embedding call.
 */

export type HistorySearchTier = 'public' | 'confidential' | 'personal' | 'product';

export interface HistoryIndexEntry {
  entryId?: string;
  sourceType: 'conversation' | 'mission' | 'trace' | 'channel';
  sourceId: string;
  sessionId?: string;
  lineageId?: string;
  timestamp: string;
  role?: string;
  content: string;
  tier: HistorySearchTier;
  scheduled?: boolean;
  subagent?: boolean;
  metadata?: Record<string, unknown>;
}

export type HistorySearchMode = 'discovery' | 'scroll' | 'browse';

export interface HistorySearchOptions {
  query?: string;
  mode?: HistorySearchMode;
  sessionId?: string;
  tiers?: HistorySearchTier[];
  maxResults?: number;
  includeScheduled?: boolean;
  includeSubagent?: boolean;
}

export interface HistorySearchResult {
  entryId: string;
  sourceType: HistoryIndexEntry['sourceType'];
  sourceId: string;
  sessionId?: string;
  lineageId?: string;
  timestamp: string;
  role?: string;
  content: string;
  snippet: string;
  contextBefore?: string;
  contextAfter?: string;
  tier: HistorySearchTier;
  scheduled: boolean;
  subagent: boolean;
  score: number;
}

export interface HistorySearchReport {
  mode: HistorySearchMode;
  query: string;
  results: HistorySearchResult[];
  rebuilt: boolean;
}

export type GovernedHistoryTier = 'confidential' | 'personal';

export interface MissionHistorySearchScope {
  missionId: string;
  tier: GovernedHistoryTier;
  missionPath: string;
}

export interface MissionHistorySearchOptions extends Omit<HistorySearchOptions, 'tiers'> {
  missionId: string;
}

const DEFAULT_MAX_RESULTS = 20;
const VALID_TIERS = new Set<HistorySearchTier>(['public', 'confidential', 'personal', 'product']);

function safeHistoryDirectory(filePath: string): string | undefined {
  try {
    const resolved = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return safeExistsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function safeHistoryFile(filePath: string): string | undefined {
  try {
    return assertSafeRepositoryPath(filePath);
  } catch {
    return undefined;
  }
}

/** Resolve an explicit tier marker from a runtime record; unknown is never public. */
export function resolveHistoryTier(raw: unknown): HistorySearchTier | undefined {
  if (!isRecord(raw)) return undefined;
  const record = raw;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const candidate =
    record.tier ??
    record.history_tier ??
    record.historyTier ??
    metadata?.tier ??
    metadata?.history_tier ??
    metadata?.historyTier;
  const normalized = String(candidate ?? '')
    .trim()
    .toLowerCase() as HistorySearchTier;
  return VALID_TIERS.has(normalized) ? normalized : undefined;
}

function databasePath(): string {
  const configured = getRegisteredEnvText('KYBERION_HISTORY_SEARCH_DB')?.trim();
  const resolved = configured
    ? pathResolver.rootResolve(configured)
    : pathResolver.shared('runtime/history-search/history.sqlite');
  const sharedRoot = path.resolve(pathResolver.shared()) + path.sep;
  const absolute = path.resolve(resolved);
  if (!absolute.startsWith(sharedRoot)) {
    throw new Error(`history search database must stay under active/shared (received ${absolute})`);
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

function sqlLiteral(value: unknown): string {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function runSql(sql: string, json = false): string {
  const db = databasePath();
  const parent = path.dirname(db);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  const result = safeExecResult('sqlite3', json ? ['-json', db] : [db], {
    timeoutMs: 10_000,
    maxOutputMB: 20,
    // The index keeps `history_fts` in sync through AFTER INSERT/DELETE/UPDATE
    // triggers on `history_entries`, and a trigger body counts as schema-defined
    // SQL. With `trusted_schema=0` SQLite refuses to use a virtual table there —
    // "unsafe use of virtual table history_fts" — so every write, and therefore
    // every search, fails. Apple's bundled sqlite3 ships that default, which is
    // why this only surfaces on macOS while Linux CI passes.
    //
    // The pragma is per-connection and each CLI invocation opens a new one, so
    // it has to lead every batch rather than being set once at schema creation.
    //
    // Scope of the relaxation: this database is created by us under active/ and
    // we author its whole schema. The protection being waived is against a
    // hostile schema inside a database file someone else planted — an attacker
    // able to do that already has write access to the repository.
    input: `PRAGMA trusted_schema=ON;\n${sql}`,
  });
  if (result.status !== 0) {
    throw new Error(
      `history search sqlite failed: ${result.stderr || result.error?.message || result.status}`
    );
  }
  return result.stdout;
}

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS history_entries (
  entry_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  session_id TEXT,
  lineage_id TEXT,
  timestamp TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  tier TEXT NOT NULL,
  scheduled INTEGER NOT NULL DEFAULT 0,
  subagent INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS history_entries_session_idx ON history_entries(session_id, timestamp);
CREATE INDEX IF NOT EXISTS history_entries_tier_idx ON history_entries(tier, timestamp);
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  content,
  content='history_entries',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS history_trigram USING fts5(
  content,
  content='history_entries',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS history_entries_ai AFTER INSERT ON history_entries BEGIN
  INSERT INTO history_fts(rowid, content) VALUES (new.rowid, new.content);
  INSERT INTO history_trigram(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS history_entries_ad AFTER DELETE ON history_entries BEGIN
  INSERT INTO history_fts(history_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO history_trigram(history_trigram, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS history_entries_au AFTER UPDATE ON history_entries BEGIN
  INSERT INTO history_fts(history_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO history_trigram(history_trigram, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO history_fts(rowid, content) VALUES (new.rowid, new.content);
  INSERT INTO history_trigram(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function ensureSchema(): void {
  runSql(SCHEMA_SQL);
}

function normalizeEntry(
  input: HistoryIndexEntry
): Required<
  Pick<
    HistoryIndexEntry,
    'sourceType' | 'sourceId' | 'timestamp' | 'content' | 'tier' | 'scheduled' | 'subagent'
  >
> &
  HistoryIndexEntry {
  if (!VALID_TIERS.has(input.tier)) throw new Error(`Unsupported history tier: ${input.tier}`);
  const content = String(input.content || '').trim();
  if (!content) throw new Error('History index content must not be empty');
  const sourceId = String(input.sourceId || '').trim();
  if (!sourceId) throw new Error('History index sourceId must not be empty');
  const entryId =
    input.entryId ||
    createHash('sha256')
      .update(
        JSON.stringify({
          sourceType: input.sourceType,
          sourceId,
          sessionId: input.sessionId || '',
          timestamp: input.timestamp,
          content,
        })
      )
      .digest('hex')
      .slice(0, 32);
  return {
    ...input,
    entryId,
    sourceId,
    content,
    scheduled: Boolean(input.scheduled),
    subagent: Boolean(input.subagent),
  } as Required<
    Pick<
      HistoryIndexEntry,
      'sourceType' | 'sourceId' | 'timestamp' | 'content' | 'tier' | 'scheduled' | 'subagent'
    >
  > &
    HistoryIndexEntry;
}

function insertSql(entry: HistoryIndexEntry): string {
  const normalized = normalizeEntry(entry);
  return `INSERT INTO history_entries
    (entry_id, source_type, source_id, session_id, lineage_id, timestamp, role, content, tier, scheduled, subagent, metadata_json)
    VALUES (${sqlLiteral(normalized.entryId)}, ${sqlLiteral(normalized.sourceType)}, ${sqlLiteral(normalized.sourceId)},
      ${sqlLiteral(normalized.sessionId || '')}, ${sqlLiteral(normalized.lineageId || '')}, ${sqlLiteral(normalized.timestamp)},
      ${sqlLiteral(normalized.role || '')}, ${sqlLiteral(normalized.content)}, ${sqlLiteral(normalized.tier)},
      ${normalized.scheduled ? 1 : 0}, ${normalized.subagent ? 1 : 0}, ${sqlLiteral(JSON.stringify(normalized.metadata || {}))});`;
}

export function indexHistoryEntry(entry: HistoryIndexEntry): string {
  ensureSchema();
  const normalized = normalizeEntry(entry);
  runSql(`BEGIN;
DELETE FROM history_entries WHERE entry_id = ${sqlLiteral(normalized.entryId)};
${insertSql(normalized)}
COMMIT;`);
  return normalized.entryId!;
}

export function rebuildHistorySearchIndex(entries: HistoryIndexEntry[]): void {
  ensureSchema();
  const uniqueEntries = new Map<string, HistoryIndexEntry>();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    uniqueEntries.set(normalized.entryId!, normalized);
  }
  const inserts = [...uniqueEntries.values()].map(insertSql).join('\n');
  runSql(`BEGIN;
DELETE FROM history_entries;
${inserts}
INSERT INTO history_fts(history_fts) VALUES ('rebuild');
INSERT INTO history_trigram(history_trigram) VALUES ('rebuild');
COMMIT;`);
}

function ensureFtsHealthy(): boolean {
  const raw = runSql(
    `SELECT (SELECT count(*) FROM history_entries) AS entries,
            (SELECT count(*) FROM history_fts) AS unicode_entries,
            (SELECT count(*) FROM history_trigram) AS trigram_entries;`,
    true
  );
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw || '[]', 'history search index response');
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) return false;
  const entries = finiteNumber(parsed[0].entries);
  const unicodeEntries = finiteNumber(parsed[0].unicode_entries);
  const trigramEntries = finiteNumber(parsed[0].trigram_entries);
  return Boolean(
    entries !== undefined &&
    unicodeEntries !== undefined &&
    trigramEntries !== undefined &&
    entries === unicodeEntries &&
    entries === trigramEntries
  );
}

function repairFts(): void {
  runSql(
    `INSERT INTO history_fts(history_fts) VALUES ('rebuild');
     INSERT INTO history_trigram(history_trigram) VALUES ('rebuild');`
  );
}

function sanitizeMatchQuery(query: string): string {
  return query
    .trim()
    .replace(/["']/gu, ' ')
    .replace(/[{}()[\]*:^~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tierClause(tiers: HistorySearchTier[]): string {
  const allowed: HistorySearchTier[] = tiers.length > 0 ? tiers : ['public'];
  if (allowed.some((tier) => !VALID_TIERS.has(tier)))
    throw new Error('Invalid history search tier');
  return `e.tier IN (${allowed.map(sqlLiteral).join(', ')})`;
}

interface SqlSearchRow {
  rowid: number;
  entry_id: string;
  source_type: HistoryIndexEntry['sourceType'];
  source_id: string;
  session_id?: string;
  lineage_id?: string;
  timestamp: string;
  role?: string;
  content: string;
  tier: HistorySearchTier;
  scheduled: number;
  subagent: number;
  snippet: string;
  rank: number;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null
    ? undefined
    : typeof value === 'string'
      ? value
      : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeSqlSearchRow(value: unknown): SqlSearchRow | undefined {
  if (!isRecord(value)) return undefined;
  const rowid = finiteNumber(value.rowid);
  const entryId = optionalString(value.entry_id);
  const sourceType = optionalString(value.source_type);
  const sourceId = optionalString(value.source_id);
  const timestamp = optionalString(value.timestamp);
  const content = optionalString(value.content);
  const tier = optionalString(value.tier);
  const scheduled = finiteNumber(value.scheduled);
  const subagent = finiteNumber(value.subagent);
  const rank = finiteNumber(value.rank);
  if (
    rowid === undefined ||
    !Number.isInteger(rowid) ||
    !entryId ||
    !sourceType ||
    !['conversation', 'mission', 'trace', 'channel'].includes(sourceType) ||
    !sourceId ||
    !timestamp ||
    !content ||
    !tier ||
    !VALID_TIERS.has(tier as HistorySearchTier) ||
    (scheduled !== 0 && scheduled !== 1) ||
    (subagent !== 0 && subagent !== 1) ||
    rank === undefined
  ) {
    return undefined;
  }
  const snippet = optionalString(value.snippet);
  return {
    rowid,
    entry_id: entryId,
    source_type: sourceType as HistoryIndexEntry['sourceType'],
    source_id: sourceId,
    ...(optionalString(value.session_id) ? { session_id: optionalString(value.session_id) } : {}),
    ...(optionalString(value.lineage_id) ? { lineage_id: optionalString(value.lineage_id) } : {}),
    timestamp,
    ...(optionalString(value.role) ? { role: optionalString(value.role) } : {}),
    content,
    tier: tier as HistorySearchTier,
    scheduled,
    subagent,
    snippet: snippet || content,
    rank,
  };
}

function parseSqlSearchRows(raw: string): SqlSearchRow[] {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw || '[]', 'history search rows response');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    const row = normalizeSqlSearchRow(value);
    return row ? [row] : [];
  });
}

function parseSqlContent(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw || '[]', 'history search content response');
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const first = parsed[0];
  return isRecord(first) && typeof first.content === 'string' ? first.content : undefined;
}

function parseSqlCount(raw: string): number {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw || '[]', 'history search count response');
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) return 0;
  const count = finiteNumber(parsed[0].count);
  return count !== undefined && count >= 0 ? count : 0;
}

function queryFtsTable(
  table: 'history_fts' | 'history_trigram',
  query: string,
  options: HistorySearchOptions,
  tiers: HistorySearchTier[]
): SqlSearchRow[] {
  const filters = [tierClause(tiers), `e.subagent = ${options.includeSubagent ? 1 : 0}`];
  if (options.includeScheduled === false) filters.push('e.scheduled = 0');
  if (options.sessionId) filters.push(`e.session_id = ${sqlLiteral(options.sessionId)}`);
  const sql = `SELECT e.rowid, e.entry_id, e.source_type, e.source_id, e.session_id,
      e.lineage_id, e.timestamp, e.role, e.content, e.tier, e.scheduled, e.subagent,
      snippet(${table}, 0, '[', ']', '…', 12) AS snippet, bm25(${table}) AS rank
    FROM ${table} JOIN history_entries e ON e.rowid = ${table}.rowid
    WHERE ${table} MATCH ${sqlLiteral(query)} AND ${filters.join(' AND ')}
    ORDER BY rank LIMIT ${Math.max(100, (options.maxResults || DEFAULT_MAX_RESULTS) * 5)};`;
  return parseSqlSearchRows(runSql(sql, true));
}

function queryBrowse(options: HistorySearchOptions, tiers: HistorySearchTier[]): SqlSearchRow[] {
  const filters = [tierClause(tiers), `e.subagent = ${options.includeSubagent ? 1 : 0}`];
  if (options.includeScheduled === false) filters.push('e.scheduled = 0');
  if (options.sessionId) filters.push(`e.session_id = ${sqlLiteral(options.sessionId)}`);
  return parseSqlSearchRows(
    runSql(
      `SELECT e.rowid, e.entry_id, e.source_type, e.source_id, e.session_id,
        e.lineage_id, e.timestamp, e.role, e.content, e.tier, e.scheduled, e.subagent,
        e.content AS snippet, 0 AS rank
       FROM history_entries e WHERE ${filters.join(' AND ')}
       ORDER BY e.timestamp DESC, e.rowid DESC LIMIT ${Math.max(100, (options.maxResults || DEFAULT_MAX_RESULTS) * 5)};`,
      true
    )
  );
}

function loadContext(
  row: SqlSearchRow,
  tiers: HistorySearchTier[]
): { before?: string; after?: string } {
  if (!row.session_id) return {};
  const where = `${tierClause(tiers)} AND e.subagent = 0 AND e.session_id = ${sqlLiteral(row.session_id)}`;
  const before = parseSqlContent(
    runSql(
      `SELECT e.content FROM history_entries e WHERE ${where} AND e.rowid < ${row.rowid} ORDER BY e.rowid DESC LIMIT 1;`,
      true
    )
  );
  const after = parseSqlContent(
    runSql(
      `SELECT e.content FROM history_entries e WHERE ${where} AND e.rowid > ${row.rowid} ORDER BY e.rowid LIMIT 1;`,
      true
    )
  );
  return { before, after };
}

export function searchHistory(options: HistorySearchOptions = {}): HistorySearchReport {
  const mode =
    options.mode || (options.sessionId ? 'scroll' : options.query ? 'discovery' : 'browse');
  const query = String(options.query || '').trim();
  if (mode === 'discovery' && !query) throw new Error('History discovery requires a query');
  if (mode === 'scroll' && !options.sessionId) throw new Error('History scroll requires sessionId');
  const tiers: HistorySearchTier[] = options.tiers?.length ? options.tiers : ['public'];
  const maxResults = clamp(options.maxResults || DEFAULT_MAX_RESULTS, 1, 100);
  let rebuilt = false;

  ensureSchema();
  try {
    if (!ensureFtsHealthy()) {
      repairFts();
      rebuilt = true;
    }
  } catch {
    repairFts();
    rebuilt = true;
  }

  const sanitized = sanitizeMatchQuery(query);
  const collectRows = (): SqlSearchRow[] => {
    if (sanitized && mode !== 'browse' && mode !== 'scroll') {
      const byId = new Map<number, SqlSearchRow>();
      for (const table of ['history_fts', 'history_trigram'] as const) {
        for (const row of queryFtsTable(table, sanitized, options, tiers)) {
          const existing = byId.get(row.rowid);
          if (!existing || Number(row.rank) < Number(existing.rank)) byId.set(row.rowid, row);
        }
      }
      return [...byId.values()];
    }
    return queryBrowse(options, tiers);
  };

  let rows = collectRows();
  if (sanitized && rows.length === 0) {
    const eligible = parseSqlCount(
      runSql(
        `SELECT count(*) AS count FROM history_entries e WHERE ${tierClause(tiers)}
          AND e.subagent = ${options.includeSubagent ? 1 : 0}
          ${options.includeScheduled === false ? 'AND e.scheduled = 0' : ''};`,
        true
      )
    );
    if (eligible > 0) {
      repairFts();
      rebuilt = true;
      rows = collectRows();
    }
  }

  const deduped = new Map<string, { row: SqlSearchRow; score: number }>();
  for (const row of rows) {
    const key = row.lineage_id || row.entry_id;
    const score = -Number(row.rank || 0) - (row.scheduled ? 0.25 : 0);
    const existing = deduped.get(key);
    if (!existing || score > existing.score) deduped.set(key, { row, score });
  }

  const results = [...deduped.values()]
    .sort((a, b) => b.score - a.score || b.row.timestamp.localeCompare(a.row.timestamp))
    .slice(0, maxResults)
    .map(({ row, score }) => {
      const context = loadContext(row, tiers);
      return {
        entryId: row.entry_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.lineage_id ? { lineageId: row.lineage_id } : {}),
        timestamp: row.timestamp,
        ...(row.role ? { role: row.role } : {}),
        content: row.content,
        snippet: row.snippet || row.content,
        ...(context.before ? { contextBefore: context.before } : {}),
        ...(context.after ? { contextAfter: context.after } : {}),
        tier: row.tier,
        scheduled: Boolean(row.scheduled),
        subagent: Boolean(row.subagent),
        score,
      } satisfies HistorySearchResult;
    });

  return { mode, query, results, rebuilt };
}

export function historySearchDatabasePath(): string {
  return databasePath();
}

export function readHistorySearchDatabaseMetadata(): { exists: boolean; bytes?: number } {
  const file = databasePath();
  if (!safeExistsSync(file)) return { exists: false };
  try {
    const raw = safeReadFile(file);
    return { exists: true, bytes: Buffer.byteLength(raw as string) };
  } catch {
    return { exists: true };
  }
}

function readValidatedTraceLines(filePath: string): Record<string, unknown>[] {
  const safePath = safeHistoryFile(filePath);
  if (!safePath) return [];
  return readJsonLines<unknown>(safePath, { onMalformed: 'skip' }).flatMap((raw) => {
    if (validateTraceReplay(raw, { strictUnknownSpans: true }).length > 0 || !isRecord(raw))
      return [];
    return [raw];
  });
}

function recordItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeMissionId(value: string): string {
  const missionId = String(value || '').trim();
  if (!missionId || !/^[A-Za-z0-9._-]{1,128}$/u.test(missionId)) {
    throw new Error('[POLICY_VIOLATION] Invalid mission id for governed history search');
  }
  return missionId;
}

/** Resolve a private scope only when the mission path and state agree on tier. */
export function resolveMissionHistoryScope(missionIdInput: string): MissionHistorySearchScope {
  const missionId = normalizeMissionId(missionIdInput);
  const missionPath = pathResolver.findMissionPath(missionId);
  if (!missionPath) {
    throw new Error(`[POLICY_VIOLATION] Mission not found: ${missionId}`);
  }
  let safeMissionPath: string;
  try {
    safeMissionPath = assertSafeRepositoryPath(missionPath);
  } catch {
    throw new Error(`[POLICY_VIOLATION] Mission path is unsafe: ${missionId}`);
  }
  const pathMatch = safeMissionPath.match(/[\\/](confidential|personal)[\\/]/iu);
  if (!pathMatch) {
    throw new Error(
      `[POLICY_VIOLATION] Governed private history search requires a confidential or personal mission: ${missionId}`
    );
  }
  const tier = pathMatch[1].toLowerCase() as GovernedHistoryTier;
  const statePath = assertSafeRepositoryPath(path.join(safeMissionPath, 'mission-state.json'));
  if (!safeExistsSync(statePath)) {
    throw new Error(`[POLICY_VIOLATION] Mission state is missing: ${missionId}`);
  }
  const state = loadMissionStateAtPath(statePath);
  if (!state) {
    throw new Error(`[POLICY_VIOLATION] Mission state is unreadable: ${missionId}`);
  }
  if (state.tier !== tier) {
    throw new Error(
      `[POLICY_VIOLATION] Mission path/state tier mismatch for governed history search: ${missionId}`
    );
  }
  return { missionId, tier, missionPath: safeMissionPath };
}

function assertMissionHistoryAccess(scope: MissionHistorySearchScope): void {
  const activeMission = getRegisteredEnvText('MISSION_ID')?.trim();
  const sudo = getRegisteredEnvText('KYBERION_SUDO');
  if (sudo === '1' || sudo === 'true' || activeMission === scope.missionId) return;
  throw new Error(
    `[POLICY_VIOLATION] Governed history search requires MISSION_ID=${scope.missionId} or KYBERION_SUDO=true`
  );
}

function explicitMissionId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const record = raw;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  const candidate =
    record.mission_id ??
    record.missionId ??
    record.mission ??
    metadata?.mission_id ??
    metadata?.missionId;
  const normalized = String(candidate ?? '').trim();
  return normalized || undefined;
}

function matchesMission(raw: unknown, missionId: string): boolean {
  return explicitMissionId(raw)?.toLowerCase() === missionId.toLowerCase();
}

function collectMissionScopedEntries(scope: MissionHistorySearchScope): HistoryIndexEntry[] {
  const entries: HistoryIndexEntry[] = [];
  const statePath = assertSafeRepositoryPath(path.join(scope.missionPath, 'mission-state.json'));
  const state = loadMissionStateAtPath(statePath);
  if (!state) return entries;
  recordItems(state.history).forEach((item, index) => {
    const content = [item.event, item.note]
      .filter((value): value is string => typeof value === 'string')
      .join(': ');
    if (!content.trim()) return;
    entries.push({
      entryId: `mission:${scope.missionId}:${index}`,
      sourceType: 'mission',
      sourceId: `${path.relative(pathResolver.rootDir(), statePath)}:${index}`,
      sessionId: scope.missionId,
      lineageId: scope.missionId,
      timestamp: String(item.ts || new Date(0).toISOString()),
      role: 'mission',
      content,
      tier: scope.tier,
      scheduled: false,
      subagent: false,
      metadata: { mission_id: scope.missionId },
    });
  });

  const conversationsDir = safeHistoryDirectory(pathResolver.shared('runtime/a2a-conversations'));
  if (conversationsDir) {
    for (const file of safeReaddir(conversationsDir).filter((name) => name.endsWith('.jsonl'))) {
      const conversationPath = safeHistoryFile(path.join(conversationsDir, file));
      if (!conversationPath) continue;
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines<unknown>(conversationPath, { onMalformed: 'skip' }).forEach((raw, index) => {
        if (!isRecord(raw)) return;
        const turn = raw;
        if (resolveHistoryTier(turn) !== scope.tier || !matchesMission(turn, scope.missionId))
          return;
        const content = [turn.prompt, turn.result]
          .filter((value) => typeof value === 'string')
          .join('\n');
        if (!content.trim()) return;
        entries.push({
          entryId: `a2a:${sessionId}:${index}`,
          sourceType: 'conversation',
          sourceId: `a2a-conversations/${file}:${index}`,
          sessionId,
          lineageId: sessionId,
          timestamp: String(turn.ts || new Date(0).toISOString()),
          role: `${String(turn.sender || 'unknown')}→${String(turn.receiver || 'unknown')}`,
          content,
          tier: scope.tier,
          scheduled: /schedule/iu.test(String(turn.performative || '')),
          subagent: /subagent/iu.test(
            `${String(turn.sender || '')} ${String(turn.receiver || '')}`
          ),
          metadata: { mission_id: scope.missionId },
        });
      });
    }
  }

  const channelRoots = [
    'telegram-bridge/thread-history',
    'discord-bridge/thread-history',
    'slack-bridge/thread-history',
    'imessage-bridge/thread-history',
  ];
  for (const root of channelRoots) {
    const directory = safeHistoryDirectory(pathResolver.shared(`runtime/${root}`));
    if (!directory) continue;
    for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
      const channelPath = safeHistoryFile(path.join(directory, file));
      if (!channelPath) continue;
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines<unknown>(channelPath, { onMalformed: 'skip' }).forEach((raw, index) => {
        if (!isRecord(raw)) return;
        const item = raw;
        if (resolveHistoryTier(item) !== scope.tier || !matchesMission(item, scope.missionId))
          return;
        const content = String(item.text || item.content || '').trim();
        if (!content) return;
        entries.push({
          entryId: `channel:${root}:${sessionId}:${index}`,
          sourceType: 'channel',
          sourceId: `runtime/${root}/${file}:${index}`,
          sessionId,
          lineageId: sessionId,
          timestamp: String(item.receivedAt || item.received_at || new Date(0).toISOString()),
          role: String(item.role || 'user'),
          content,
          tier: scope.tier,
          scheduled: false,
          subagent: false,
          metadata: { mission_id: scope.missionId },
        });
      });
    }
  }

  const traceDirectory = safeHistoryDirectory(pathResolver.shared('logs/traces'));
  if (traceDirectory) {
    for (const file of safeReaddir(traceDirectory).filter(
      (name) => name.startsWith('traces-') && name.endsWith('.jsonl')
    )) {
      readValidatedTraceLines(path.join(traceDirectory, file)).forEach((trace) => {
        const metadata = isRecord(trace.metadata) ? trace.metadata : {};
        if (resolveHistoryTier(trace) !== scope.tier || !matchesMission(trace, scope.missionId))
          return;
        const visit = (span: Record<string, unknown>): void => {
          const events = Array.isArray(span.events) ? span.events : [];
          const content = [
            span.name,
            span.error,
            ...events.map((event) => {
              if (!isRecord(event)) return '';
              const item = event;
              return [item.name, JSON.stringify(item.attributes || {})].filter(Boolean).join(': ');
            }),
          ]
            .filter(Boolean)
            .join('\n');
          if (content.trim()) {
            const traceId = String(trace.traceId || 'unknown');
            const spanId = String(span.spanId || traceId);
            entries.push({
              entryId: `trace:${traceId}:${spanId}`,
              sourceType: 'trace',
              sourceId: `logs/traces/${file}:${spanId}`,
              sessionId: String(metadata.correlationId || traceId),
              lineageId: traceId,
              timestamp: String(span.startTime || metadata.startedAt || new Date(0).toISOString()),
              role: 'trace',
              content,
              tier: scope.tier,
              scheduled: /cron|schedule|timer/iu.test(content),
              subagent: /subagent/iu.test(content),
              metadata: { mission_id: scope.missionId },
            });
          }
          for (const child of Array.isArray(span.children) ? span.children : []) {
            if (isRecord(child)) visit(child);
          }
        };
        if (isRecord(trace.rootSpan)) {
          visit(trace.rootSpan);
        }
      });
    }
  }
  return entries;
}

function scopedDatabasePath(scope: MissionHistorySearchScope): string {
  return assertSafeRepositoryPath(
    pathResolver.shared(`runtime/history-search/${scope.tier}/${scope.missionId}.sqlite`),
    { allowMissingLeaf: true }
  );
}

function withDatabasePath<T>(database: string, callback: () => T): T {
  const previous = getRegisteredEnvText('KYBERION_HISTORY_SEARCH_DB');
  setRegisteredEnv('KYBERION_HISTORY_SEARCH_DB', database);
  try {
    return callback();
  } finally {
    setRegisteredEnv('KYBERION_HISTORY_SEARCH_DB', previous);
  }
}

/** Rebuild only the current private mission's isolated history database. */
export function rebuildMissionHistorySearchIndex(missionId: string): number {
  const scope = resolveMissionHistoryScope(missionId);
  assertMissionHistoryAccess(scope);
  return withExecutionContext('mission_controller', () =>
    withDatabasePath(scopedDatabasePath(scope), () => {
      const entries = collectMissionScopedEntries(scope);
      rebuildHistorySearchIndex(entries);
      return entries.length;
    })
  );
}

/** Search a private mission history without ever accepting an arbitrary tier. */
export function searchMissionHistory(options: MissionHistorySearchOptions): HistorySearchReport {
  const scope = resolveMissionHistoryScope(options.missionId);
  assertMissionHistoryAccess(scope);
  return withExecutionContext('mission_controller', () =>
    withDatabasePath(scopedDatabasePath(scope), () => {
      const entries = collectMissionScopedEntries(scope);
      rebuildHistorySearchIndex(entries);
      const report = searchHistory({ ...options, tiers: [scope.tier] });
      return { ...report, rebuilt: true };
    })
  );
}

function collectPublicA2AEntries(): HistoryIndexEntry[] {
  const directory = safeHistoryDirectory(pathResolver.shared('runtime/a2a-conversations'));
  if (!directory) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
    const conversationPath = safeHistoryFile(path.join(directory, file));
    if (!conversationPath) continue;
    const sessionId = file.replace(/\.jsonl$/u, '');
    readJsonLines<unknown>(conversationPath, { onMalformed: 'skip' }).forEach((raw, index) => {
      if (!isRecord(raw)) return;
      const turn = raw;
      if (resolveHistoryTier(turn) !== 'public') return;
      const content = [turn.prompt, turn.result]
        .filter((value) => typeof value === 'string')
        .join('\n');
      if (!content.trim()) return;
      entries.push({
        entryId: `a2a:${sessionId}:${index}`,
        sourceType: 'conversation',
        sourceId: `a2a-conversations/${file}:${index}`,
        sessionId,
        lineageId: sessionId,
        timestamp: String(turn.ts || new Date(0).toISOString()),
        role: `${String(turn.sender || 'unknown')}→${String(turn.receiver || 'unknown')}`,
        content,
        tier: 'public',
        scheduled: String(turn.performative || '')
          .toLowerCase()
          .includes('schedule'),
        subagent: `${String(turn.sender || '')} ${String(turn.receiver || '')}`
          .toLowerCase()
          .includes('subagent'),
      });
    });
  }
  return entries;
}

function collectPublicMissionEntries(): HistoryIndexEntry[] {
  const directory = safeHistoryDirectory(pathResolver.active('missions/public'));
  if (!directory) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const missionId of safeReaddir(directory)) {
    const statePath = safeHistoryFile(path.join(directory, missionId, 'mission-state.json'));
    if (!statePath) continue;
    const state = loadMissionStateAtPath(statePath);
    if (!state) continue;
    if (state.tier !== 'public') continue;
    recordItems(state.history).forEach((item, index) => {
      const content = [item.event, item.note]
        .filter((value): value is string => typeof value === 'string')
        .join(': ');
      if (!content.trim()) return;
      entries.push({
        entryId: `mission:${missionId}:${index}`,
        sourceType: 'mission',
        sourceId: `missions/public/${missionId}/mission-state.json:${index}`,
        sessionId: missionId,
        lineageId: missionId,
        timestamp: String(item.ts || new Date(0).toISOString()),
        role: 'mission',
        content,
        tier: 'public',
        scheduled: false,
        subagent: false,
      });
    });
  }
  return entries;
}

function collectPublicChannelEntries(): HistoryIndexEntry[] {
  const roots = ['telegram-bridge/thread-history', 'discord-bridge/thread-history'];
  const entries: HistoryIndexEntry[] = [];
  for (const root of roots) {
    const directory = safeHistoryDirectory(pathResolver.shared(`runtime/${root}`));
    if (!directory) continue;
    for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
      const channelPath = safeHistoryFile(path.join(directory, file));
      if (!channelPath) continue;
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines<unknown>(channelPath, { onMalformed: 'skip' }).forEach((raw, index) => {
        if (!isRecord(raw)) return;
        const item = raw;
        if (resolveHistoryTier(item) !== 'public') return;
        const content = String(item.text || item.content || '').trim();
        if (!content) return;
        entries.push({
          entryId: `channel:${root}:${sessionId}:${index}`,
          sourceType: 'channel',
          sourceId: `runtime/${root}/${file}:${index}`,
          sessionId,
          lineageId: sessionId,
          timestamp: String(item.receivedAt || item.received_at || new Date(0).toISOString()),
          role: String(item.role || 'user'),
          content,
          tier: 'public',
          scheduled: false,
          subagent: false,
        });
      });
    }
  }
  return entries;
}

function collectPublicTraceEntries(): HistoryIndexEntry[] {
  const directory = safeHistoryDirectory(pathResolver.shared('logs/traces'));
  if (!directory) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const file of safeReaddir(directory).filter(
    (name) => name.startsWith('traces-') && name.endsWith('.jsonl')
  )) {
    readValidatedTraceLines(path.join(directory, file)).forEach((trace) => {
      const metadata = isRecord(trace.metadata) ? trace.metadata : {};
      if (resolveHistoryTier(trace) !== 'public') return;
      // Mission-bound traces may carry confidential or personal content. They
      // are indexed by a future tier-specific collector, never public here.
      if (metadata.missionId || metadata.mission_id) return;
      const visit = (span: Record<string, unknown>): void => {
        const events = Array.isArray(span.events) ? span.events : [];
        const content = [
          span.name,
          span.error,
          ...events.map((event) => {
            if (!isRecord(event)) return '';
            const item = event;
            return [item.name, JSON.stringify(item.attributes || {})].filter(Boolean).join(': ');
          }),
        ]
          .filter(Boolean)
          .join('\n');
        if (content.trim()) {
          const traceId = String(trace.traceId || 'unknown');
          const spanId = String(span.spanId || traceId);
          entries.push({
            entryId: `trace:${traceId}:${spanId}`,
            sourceType: 'trace',
            sourceId: `logs/traces/${file}:${spanId}`,
            sessionId: String(metadata.correlationId || traceId),
            lineageId: traceId,
            timestamp: String(span.startTime || metadata.startedAt || new Date(0).toISOString()),
            role: 'trace',
            content,
            tier: 'public',
            scheduled: /cron|schedule|timer/iu.test(content),
            subagent: /subagent/iu.test(content),
          });
        }
        for (const child of Array.isArray(span.children) ? span.children : []) {
          if (isRecord(child)) visit(child);
        }
      };
      if (isRecord(trace.rootSpan)) {
        visit(trace.rootSpan);
      }
    });
  }
  return entries;
}

/**
 * Rebuild the default public index from existing public-tier runtime files.
 * Higher-tier sources are intentionally not scanned into the shared database.
 */
export function rebuildPublicHistorySearchIndexFromLocalSources(): number {
  const entries = [
    ...collectPublicA2AEntries(),
    ...collectPublicMissionEntries(),
    ...collectPublicChannelEntries(),
    ...collectPublicTraceEntries(),
  ];
  rebuildHistorySearchIndex(entries);
  return entries.length;
}
