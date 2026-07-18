import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { safeExec, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  historySearchDatabasePath,
  indexHistoryEntry,
  rebuildMissionHistorySearchIndex,
  rebuildHistorySearchIndex,
  resolveMissionHistoryScope,
  resolveHistoryTier,
  searchMissionHistory,
  searchHistory,
  type HistoryIndexEntry,
} from './history-search-index.js';

const DB_PATH = 'active/shared/tmp/ha02-history-search-test.sqlite';
const PRIVATE_MISSION_ID = `MSN-HA02-PRIVATE-TEST-${process.pid}-${Date.now()}`;
const PRIVATE_CONVERSATION_ID = `CONV-HA02-PRIVATE-TEST-${process.pid}-${Date.now()}`;
const PRIVATE_MISSION_PATH = `active/missions/confidential/${PRIVATE_MISSION_ID}`;
const PRIVATE_CONVERSATION_PATH = `active/shared/runtime/a2a-conversations/${PRIVATE_CONVERSATION_ID}.jsonl`;
const PRIVATE_DATABASE_PATH = pathResolver.shared(
  `runtime/history-search/confidential/${PRIVATE_MISSION_ID}.sqlite`
);

function entry(
  input: Partial<HistoryIndexEntry> & Pick<HistoryIndexEntry, 'entryId' | 'content'>
): HistoryIndexEntry {
  return {
    sourceType: 'conversation',
    sourceId: input.entryId,
    timestamp: '2026-07-18T00:00:00.000Z',
    tier: 'public',
    sessionId: 'session-1',
    ...input,
  };
}

describe('history-search-index', () => {
  afterEach(() => {
    delete process.env.KYBERION_HISTORY_SEARCH_DB;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        safeRmSync(`${DB_PATH}${suffix}`, { force: true });
      } catch {
        // Test cleanup is best-effort.
      }
    }
    const previousMissionId = process.env.MISSION_ID;
    process.env.MISSION_ID = PRIVATE_MISSION_ID;
    withExecutionContext('mission_controller', () => {
      for (const file of [
        `${PRIVATE_DATABASE_PATH}`,
        `${PRIVATE_DATABASE_PATH}-wal`,
        `${PRIVATE_DATABASE_PATH}-shm`,
        pathResolver.rootResolve(PRIVATE_CONVERSATION_PATH),
      ]) {
        try {
          safeRmSync(file, { force: true });
        } catch {
          // Best-effort fixture cleanup.
        }
      }
      try {
        safeRmSync(pathResolver.rootResolve(PRIVATE_MISSION_PATH), {
          recursive: true,
          force: true,
        });
      } catch {
        // Best-effort fixture cleanup.
      }
    });
    if (previousMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = previousMissionId;
  });

  it('finds Japanese substrings with zero-LLM FTS and returns nearby context', () => {
    process.env.KYBERION_HISTORY_SEARCH_DB = DB_PATH;
    rebuildHistorySearchIndex([
      entry({ entryId: 'before', content: '請求書の対象月を確認します。' }),
      entry({ entryId: 'hit', content: '東京の請求書を確認しました。', lineageId: 'delivery-1' }),
      entry({ entryId: 'after', content: '次に支払予定日を確認します。' }),
    ]);

    const report = searchHistory({ query: '請求書', tiers: ['public'] });
    expect(report.mode).toBe('discovery');
    expect(report.results).toContainEqual(
      expect.objectContaining({
        entryId: 'hit',
        content: '東京の請求書を確認しました。',
        contextBefore: '請求書の対象月を確認します。',
        contextAfter: '次に支払予定日を確認します。',
      })
    );
  });

  it('enforces tier isolation and ranks scheduled history below interactive history', () => {
    process.env.KYBERION_HISTORY_SEARCH_DB = DB_PATH;
    rebuildHistorySearchIndex([
      entry({ entryId: 'interactive', content: 'リリース報告を確認した。' }),
      entry({ entryId: 'cron', content: 'リリース報告を確認した。', scheduled: true }),
      entry({ entryId: 'personal', content: '個人のリリース報告。', tier: 'personal' }),
      entry({ entryId: 'subagent', content: 'リリース報告の内部検討。', subagent: true }),
    ]);

    const publicResults = searchHistory({ query: 'リリース報告', tiers: ['public'] }).results;
    expect(publicResults.map((result) => result.entryId)).toEqual(['interactive', 'cron']);
    expect(publicResults.every((result) => result.tier === 'public')).toBe(true);
    expect(searchHistory({ query: 'リリース報告', tiers: ['public'] }).results).not.toContainEqual(
      expect.objectContaining({ entryId: 'subagent' })
    );
    expect(searchHistory({ query: 'リリース報告', tiers: ['personal'] }).results).toContainEqual(
      expect.objectContaining({ entryId: 'personal', tier: 'personal' })
    );
  });

  it('repairs a missing FTS index on the next query', () => {
    process.env.KYBERION_HISTORY_SEARCH_DB = DB_PATH;
    indexHistoryEntry(entry({ entryId: 'repair-me', content: '復旧対象の会話です。' }));
    safeExec('sqlite3', [
      historySearchDatabasePath(),
      'DELETE FROM history_fts; DELETE FROM history_trigram;',
    ]);

    const report = searchHistory({ query: '復旧対象', tiers: ['public'] });
    expect(report.rebuilt).toBe(true);
    expect(report.results[0]?.entryId).toBe('repair-me');
  });

  it('deduplicates repeated source entries during a full rebuild', () => {
    process.env.KYBERION_HISTORY_SEARCH_DB = DB_PATH;
    const duplicate = entry({ entryId: 'duplicate', content: '重複する履歴です。' });
    rebuildHistorySearchIndex([duplicate, { ...duplicate, sourceId: 'same-source-again' }]);

    expect(searchHistory({ query: '重複する', tiers: ['public'] }).results).toEqual([
      expect.objectContaining({ entryId: 'duplicate' }),
    ]);
  });

  it('requires explicit provenance before a runtime record can enter public history', () => {
    expect(resolveHistoryTier({ text: 'unknown' })).toBeUndefined();
    expect(resolveHistoryTier({ text: 'public', metadata: { tier: 'public' } })).toBe('public');
    expect(resolveHistoryTier({ text: 'private', tier: 'confidential' })).toBe('confidential');
  });

  it('rebuilds and searches an isolated private mission index only with matching mission authority', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(pathResolver.rootResolve(PRIVATE_MISSION_PATH), { recursive: true });
      safeWriteFile(
        pathResolver.rootResolve(`${PRIVATE_MISSION_PATH}/mission-state.json`),
        JSON.stringify({
          tier: 'confidential',
          mission_id: PRIVATE_MISSION_ID,
          history: [
            {
              ts: '2026-07-18T00:00:00.000Z',
              event: 'PRIVATE_CHECK',
              note: 'confidential invoice recovery',
            },
          ],
        })
      );
      safeWriteFile(
        pathResolver.rootResolve(PRIVATE_CONVERSATION_PATH),
        `${JSON.stringify({
          ts: '2026-07-18T00:01:00.000Z',
          sender: 'private-worker',
          receiver: 'mission-controller',
          performative: 'request',
          prompt: 'confidential invoice recovery detail',
          result: 'private result',
          mission_id: PRIVATE_MISSION_ID,
          tier: 'confidential',
        })}\n`
      );
    });

    process.env.MISSION_ID = PRIVATE_MISSION_ID;
    expect(resolveMissionHistoryScope(PRIVATE_MISSION_ID)).toMatchObject({
      missionId: PRIVATE_MISSION_ID,
      tier: 'confidential',
    });
    expect(rebuildMissionHistorySearchIndex(PRIVATE_MISSION_ID)).toBe(2);
    const report = searchMissionHistory({
      missionId: PRIVATE_MISSION_ID,
      query: 'confidential invoice',
      maxResults: 10,
    });
    expect(report.rebuilt).toBe(true);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.every((result) => result.tier === 'confidential')).toBe(true);
    expect(report.results.some((result) => result.sourceType === 'conversation')).toBe(true);
  });

  it('denies private search when the active mission does not match', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(pathResolver.rootResolve(PRIVATE_MISSION_PATH), { recursive: true });
      safeWriteFile(
        pathResolver.rootResolve(`${PRIVATE_MISSION_PATH}/mission-state.json`),
        JSON.stringify({ tier: 'confidential', mission_id: PRIVATE_MISSION_ID, history: [] })
      );
    });
    process.env.MISSION_ID = `${PRIVATE_MISSION_ID}-other`;
    expect(() => searchMissionHistory({ missionId: PRIVATE_MISSION_ID, mode: 'browse' })).toThrow(
      'requires MISSION_ID'
    );
  });
});
