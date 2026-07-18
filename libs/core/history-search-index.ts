import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeReaddir,
  safeReadFile,
} from './secure-io.js';
import { withExecutionContext } from './authority.js';

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

/** Resolve an explicit tier marker from a runtime record; unknown is never public. */
export function resolveHistoryTier(raw: unknown): HistorySearchTier | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : undefined;
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
  const configured = process.env.KYBERION_HISTORY_SEARCH_DB?.trim();
  return configured
    ? pathResolver.rootResolve(configured)
    : pathResolver.shared('runtime/history-search/history.sqlite');
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
    input: sql,
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
  const row = JSON.parse(raw || '[]')[0] as
    | { entries: number; unicode_entries: number; trigram_entries: number }
    | undefined;
  return Boolean(row && row.entries === row.unicode_entries && row.entries === row.trigram_entries);
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
  session_id: string;
  lineage_id: string;
  timestamp: string;
  role: string;
  content: string;
  tier: HistorySearchTier;
  scheduled: number;
  subagent: number;
  snippet: string;
  rank: number;
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
  return JSON.parse(runSql(sql, true) || '[]') as SqlSearchRow[];
}

function queryBrowse(options: HistorySearchOptions, tiers: HistorySearchTier[]): SqlSearchRow[] {
  const filters = [tierClause(tiers), `e.subagent = ${options.includeSubagent ? 1 : 0}`];
  if (options.includeScheduled === false) filters.push('e.scheduled = 0');
  if (options.sessionId) filters.push(`e.session_id = ${sqlLiteral(options.sessionId)}`);
  return JSON.parse(
    runSql(
      `SELECT e.rowid, e.entry_id, e.source_type, e.source_id, e.session_id,
        e.lineage_id, e.timestamp, e.role, e.content, e.tier, e.scheduled, e.subagent,
        e.content AS snippet, 0 AS rank
       FROM history_entries e WHERE ${filters.join(' AND ')}
       ORDER BY e.timestamp DESC, e.rowid DESC LIMIT ${Math.max(100, (options.maxResults || DEFAULT_MAX_RESULTS) * 5)};`,
      true
    ) || '[]'
  ) as SqlSearchRow[];
}

function loadContext(
  row: SqlSearchRow,
  tiers: HistorySearchTier[]
): { before?: string; after?: string } {
  if (!row.session_id) return {};
  const where = `${tierClause(tiers)} AND e.subagent = 0 AND e.session_id = ${sqlLiteral(row.session_id)}`;
  const before = JSON.parse(
    runSql(
      `SELECT e.content FROM history_entries e WHERE ${where} AND e.rowid < ${row.rowid} ORDER BY e.rowid DESC LIMIT 1;`,
      true
    ) || '[]'
  )[0]?.content as string | undefined;
  const after = JSON.parse(
    runSql(
      `SELECT e.content FROM history_entries e WHERE ${where} AND e.rowid > ${row.rowid} ORDER BY e.rowid LIMIT 1;`,
      true
    ) || '[]'
  )[0]?.content as string | undefined;
  return { before, after };
}

export function searchHistory(options: HistorySearchOptions = {}): HistorySearchReport {
  const mode =
    options.mode || (options.sessionId ? 'scroll' : options.query ? 'discovery' : 'browse');
  const query = String(options.query || '').trim();
  if (mode === 'discovery' && !query) throw new Error('History discovery requires a query');
  if (mode === 'scroll' && !options.sessionId) throw new Error('History scroll requires sessionId');
  const tiers: HistorySearchTier[] = options.tiers?.length ? options.tiers : ['public'];
  const maxResults = Math.max(1, Math.min(100, options.maxResults || DEFAULT_MAX_RESULTS));
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
    const eligible = JSON.parse(
      runSql(
        `SELECT count(*) AS count FROM history_entries e WHERE ${tierClause(tiers)}
          AND e.subagent = ${options.includeSubagent ? 1 : 0}
          ${options.includeScheduled === false ? 'AND e.scheduled = 0' : ''};`,
        true
      ) || '[]'
    )[0]?.count;
    if (Number(eligible) > 0) {
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

function readJsonLines(filePath: string): unknown[] {
  if (!safeExistsSync(filePath)) return [];
  return String(safeReadFile(filePath, { encoding: 'utf8' }) || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
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
  const pathMatch = missionPath.match(/[\\/](confidential|personal)[\\/]/iu);
  if (!pathMatch) {
    throw new Error(
      `[POLICY_VIOLATION] Governed private history search requires a confidential or personal mission: ${missionId}`
    );
  }
  const tier = pathMatch[1].toLowerCase() as GovernedHistoryTier;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) {
    throw new Error(`[POLICY_VIOLATION] Mission state is missing: ${missionId}`);
  }
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }) || '{}')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(`[POLICY_VIOLATION] Mission state is unreadable: ${missionId}`);
  }
  if (resolveHistoryTier(state) !== tier) {
    throw new Error(
      `[POLICY_VIOLATION] Mission path/state tier mismatch for governed history search: ${missionId}`
    );
  }
  return { missionId, tier, missionPath };
}

function assertMissionHistoryAccess(scope: MissionHistorySearchScope): void {
  const activeMission = process.env.MISSION_ID?.trim();
  if (process.env.KYBERION_SUDO === 'true' || activeMission === scope.missionId) return;
  throw new Error(
    `[POLICY_VIOLATION] Governed history search requires MISSION_ID=${scope.missionId} or KYBERION_SUDO=true`
  );
}

function explicitMissionId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : undefined;
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
  const statePath = path.join(scope.missionPath, 'mission-state.json');
  const state = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }) || '{}')) as Record<
    string,
    unknown
  >;
  const history = Array.isArray(state.history) ? state.history : [];
  history.forEach((raw, index) => {
    const item = raw as Record<string, unknown>;
    const content = [item.event, item.note].filter(Boolean).join(': ');
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

  const conversationsDir = pathResolver.shared('runtime/a2a-conversations');
  if (safeExistsSync(conversationsDir)) {
    for (const file of safeReaddir(conversationsDir).filter((name) => name.endsWith('.jsonl'))) {
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines(path.join(conversationsDir, file)).forEach((raw, index) => {
        const turn = raw as Record<string, unknown>;
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
    const directory = pathResolver.shared(`runtime/${root}`);
    if (!safeExistsSync(directory)) continue;
    for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines(path.join(directory, file)).forEach((raw, index) => {
        const item = raw as Record<string, unknown>;
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

  const traceDirectory = pathResolver.shared('logs/traces');
  if (safeExistsSync(traceDirectory)) {
    for (const file of safeReaddir(traceDirectory).filter(
      (name) => name.startsWith('traces-') && name.endsWith('.jsonl')
    )) {
      readJsonLines(path.join(traceDirectory, file)).forEach((raw) => {
        const trace = raw as Record<string, unknown>;
        const metadata = (trace.metadata || {}) as Record<string, unknown>;
        if (resolveHistoryTier(trace) !== scope.tier || !matchesMission(trace, scope.missionId))
          return;
        const visit = (span: Record<string, unknown>): void => {
          const events = Array.isArray(span.events) ? span.events : [];
          const content = [
            span.name,
            span.error,
            ...events.map((event) => {
              const item = event as Record<string, unknown>;
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
            visit(child as Record<string, unknown>);
          }
        };
        if (trace.rootSpan && typeof trace.rootSpan === 'object') {
          visit(trace.rootSpan as Record<string, unknown>);
        }
      });
    }
  }
  return entries;
}

function scopedDatabasePath(scope: MissionHistorySearchScope): string {
  return pathResolver.shared(`runtime/history-search/${scope.tier}/${scope.missionId}.sqlite`);
}

function withDatabasePath<T>(database: string, callback: () => T): T {
  const previous = process.env.KYBERION_HISTORY_SEARCH_DB;
  process.env.KYBERION_HISTORY_SEARCH_DB = database;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.KYBERION_HISTORY_SEARCH_DB;
    else process.env.KYBERION_HISTORY_SEARCH_DB = previous;
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
  const directory = pathResolver.shared('runtime/a2a-conversations');
  if (!safeExistsSync(directory)) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
    const sessionId = file.replace(/\.jsonl$/u, '');
    readJsonLines(path.join(directory, file)).forEach((raw, index) => {
      const turn = raw as Record<string, unknown>;
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
  const directory = pathResolver.active('missions/public');
  if (!safeExistsSync(directory)) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const missionId of safeReaddir(directory)) {
    const statePath = path.join(directory, missionId, 'mission-state.json');
    if (!safeExistsSync(statePath)) continue;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }) || '{}')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    if (
      String(state.tier || '')
        .trim()
        .toLowerCase() !== 'public'
    )
      continue;
    const history = Array.isArray(state.history) ? state.history : [];
    history.forEach((raw, index) => {
      const item = raw as Record<string, unknown>;
      const content = [item.event, item.note].filter(Boolean).join(': ');
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
    const directory = pathResolver.shared(`runtime/${root}`);
    if (!safeExistsSync(directory)) continue;
    for (const file of safeReaddir(directory).filter((name) => name.endsWith('.jsonl'))) {
      const sessionId = file.replace(/\.jsonl$/u, '');
      readJsonLines(path.join(directory, file)).forEach((raw, index) => {
        const item = raw as Record<string, unknown>;
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
  const directory = pathResolver.shared('logs/traces');
  if (!safeExistsSync(directory)) return [];
  const entries: HistoryIndexEntry[] = [];
  for (const file of safeReaddir(directory).filter(
    (name) => name.startsWith('traces-') && name.endsWith('.jsonl')
  )) {
    readJsonLines(path.join(directory, file)).forEach((raw) => {
      const trace = raw as Record<string, unknown>;
      const metadata = (trace.metadata || {}) as Record<string, unknown>;
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
            const item = event as Record<string, unknown>;
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
          visit(child as Record<string, unknown>);
        }
      };
      if (trace.rootSpan && typeof trace.rootSpan === 'object') {
        visit(trace.rootSpan as Record<string, unknown>);
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
