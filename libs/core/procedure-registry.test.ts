import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROCEDURE_RESOLUTION_THRESHOLDS,
  type ProcedureEntry,
} from './procedure-types.js';
import {
  invalidateProcedureCache,
  loadProcedures,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from './procedure-registry.js';
import * as secureIo from './secure-io.js';
import { resetReasoningBackend, registerReasoningBackend, stubReasoningBackend, type ReasoningBackend } from './reasoning-backend.js';

const BROWSER_ENTRY: ProcedureEntry = {
  procedure_id: 'attendance.approve.kingoftime',
  substrate: 'browser',
  adapter: { recorder: 'chrome-extension', executor: 'extension_session' },
  target: { name: 'King of Time', origins: ['https://s2.kingtime.jp'] },
  intent_phrases: ['勤怠の承認', '勤怠承認'],
  execution_substrate: 'extension',
  pipeline_ref: 'pipelines/browser/attendance-approve.json',
  risk_class: 'high',
  version: '1.0.0',
  status: 'active',
};

const SERVICE_ENTRY: ProcedureEntry = {
  procedure_id: 'deal.intake',
  substrate: 'service',
  adapter: { recorder: 'service-capture', executor: 'service:preset' },
  target: { name: 'Deal Intake', services: ['jira', 'slack'] },
  intent_phrases: ['起票して通知', '案件を登録'],
  pipeline_ref: 'pipelines/service/deal-intake.json',
  risk_class: 'medium',
  version: '1.0.0',
  status: 'active',
};

const DEPRECATED_ENTRY: ProcedureEntry = {
  ...BROWSER_ENTRY,
  procedure_id: 'attendance.approve.old',
  status: 'deprecated',
};

function stubCatalog(entries: ProcedureEntry[] = [BROWSER_ENTRY, SERVICE_ENTRY, DEPRECATED_ENTRY]) {
  vi.spyOn(secureIo, 'safeReadFile').mockReturnValue(
    JSON.stringify({ schema_version: 'procedures.v1', procedures: entries }),
  );
}

describe('procedure-registry', () => {
  afterEach(() => {
    invalidateProcedureCache();
    vi.restoreAllMocks();
    resetReasoningBackend();
  });

  // -------------------------------------------------------------------------
  // loadProcedures
  // -------------------------------------------------------------------------
  describe('loadProcedures', () => {
    it('returns empty array when file is missing', () => {
      vi.spyOn(secureIo, 'safeReadFile').mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(loadProcedures(true)).toEqual([]);
    });

    it('returns all entries including deprecated', () => {
      stubCatalog();
      const entries = loadProcedures(true);
      expect(entries).toHaveLength(3);
    });

    it('caches on second call without forceRefresh', () => {
      const spy = vi.spyOn(secureIo, 'safeReadFile').mockReturnValue(
        JSON.stringify({ schema_version: 'procedures.v1', procedures: [] }),
      );
      loadProcedures(true);   // force refresh — reads file
      loadProcedures();       // uses cache
      loadProcedures();       // uses cache again
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('drops duplicate procedure_ids, keeping the first (S-H1/AR-M2)', () => {
      const dup: ProcedureEntry = { ...SERVICE_ENTRY, procedure_id: BROWSER_ENTRY.procedure_id };
      stubCatalog([BROWSER_ENTRY, dup]);
      const entries = loadProcedures(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].substrate).toBe('browser'); // first one wins
    });

    it('drops structurally-invalid entries', () => {
      stubCatalog([BROWSER_ENTRY, { procedure_id: '', intent_phrases: [] } as unknown as ProcedureEntry]);
      expect(loadProcedures(true)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // resolveAllowlistedRecordingRef — recording_ref trust boundary (S-H1)
  // -------------------------------------------------------------------------
  describe('resolveAllowlistedRecordingRef', () => {
    it('accepts a path inside the recordings store', () => {
      expect(
        resolveAllowlistedRecordingRef('active/shared/runtime/recordings/foo.json'),
      ).not.toBeNull();
    });

    it('rejects undefined / empty', () => {
      expect(resolveAllowlistedRecordingRef(undefined)).toBeNull();
      expect(resolveAllowlistedRecordingRef('')).toBeNull();
    });

    it('rejects traversal escapes out of the store', () => {
      expect(
        resolveAllowlistedRecordingRef('active/shared/runtime/recordings/../../../../etc/passwd'),
      ).toBeNull();
    });

    it('rejects paths outside the store (e.g. knowledge/)', () => {
      expect(resolveAllowlistedRecordingRef('knowledge/product/orchestration/procedures.json')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveProcedure — unmatched cases
  // -------------------------------------------------------------------------
  describe('resolveProcedure — unmatched', () => {
    it('returns unmatched + Pattern A for completely unknown intent', async () => {
      stubCatalog();
      const result = await resolveProcedure('完全に関係ないこと');
      expect(result.outcome).toBe('unmatched');
      expect(result.recommendedPattern).toBe('A');
      expect(result.candidates).toHaveLength(0);
    });

    it('returns unmatched when catalog is empty', async () => {
      stubCatalog([]);
      const result = await resolveProcedure('勤怠の承認');
      expect(result.outcome).toBe('unmatched');
    });

    it('ignores deprecated entries', async () => {
      stubCatalog([DEPRECATED_ENTRY]);
      const result = await resolveProcedure('勤怠の承認');
      expect(result.outcome).toBe('unmatched');
    });
  });

  // -------------------------------------------------------------------------
  // resolveProcedure — matched (Pattern B)
  // -------------------------------------------------------------------------
  describe('resolveProcedure — matched', () => {
    it('matches exact phrase → Pattern B', async () => {
      stubCatalog();
      const result = await resolveProcedure('勤怠の承認');
      expect(result.outcome).toBe('matched');
      expect(result.best?.procedure_id).toBe('attendance.approve.kingoftime');
      expect(result.best?.confidence).toBeGreaterThanOrEqual(PROCEDURE_RESOLUTION_THRESHOLDS.autoExecute);
      expect(result.recommendedPattern).toBe('B');
    });

    it('matches phrase embedded in longer intent', async () => {
      stubCatalog();
      const result = await resolveProcedure('ブラウザで勤怠管理サービスの勤怠の承認をしておいて');
      expect(result.outcome).toBe('matched');
      expect(result.best?.procedure_id).toBe('attendance.approve.kingoftime');
    });

    it('origin affinity boosts matching procedure', async () => {
      stubCatalog();
      const withOrigin = await resolveProcedure('勤怠の承認', { origin: 'https://s2.kingtime.jp' });
      const withoutOrigin = await resolveProcedure('勤怠の承認');
      expect(withOrigin.best?.confidence).toBeGreaterThanOrEqual(
        withoutOrigin.best?.confidence ?? 0,
      );
    });

    it('substrate filter eliminates wrong-substrate entries', async () => {
      stubCatalog();
      const result = await resolveProcedure('勤怠の承認', { substrate: 'service' });
      // BROWSER_ENTRY has substrate=browser; filtered out → unmatched
      expect(result.outcome).toBe('unmatched');
    });

    it('matches service entry by phrase', async () => {
      stubCatalog();
      const result = await resolveProcedure('起票して通知してください');
      expect(result.outcome).toBe('matched');
      expect(result.best?.procedure_id).toBe('deal.intake');
    });
  });

  // -------------------------------------------------------------------------
  // resolveProcedure — stub backend skips Stage 2
  // -------------------------------------------------------------------------
  describe('resolveProcedure — stub backend (offline)', () => {
    it('never calls delegateTask in stub mode even when Stage 1 is ambiguous', async () => {
      // Two entries with identical phrase → both score 0.9 → Stage 1 ambiguous
      const altEntry: ProcedureEntry = {
        ...BROWSER_ENTRY,
        procedure_id: 'attendance.approve.freee',
        target: { name: 'Freee HR', origins: ['https://p.freee.co.jp'] },
        intent_phrases: ['勤怠の承認'],
      };
      stubCatalog([BROWSER_ENTRY, altEntry]);
      const delegateSpy = vi.spyOn(stubReasoningBackend, 'delegateTask');
      const result = await resolveProcedure('勤怠の承認');
      expect(delegateSpy).not.toHaveBeenCalled();
      expect(result.outcome).toBe('ambiguous');
    });
  });

  // -------------------------------------------------------------------------
  // resolveProcedure — non-stub backend re-ranks ambiguous
  // -------------------------------------------------------------------------
  describe('resolveProcedure — LLM re-ranking', () => {
    /** Two entries with the same phrase force Stage 1 into ambiguous territory. */
    function twoIdenticalPhraseEntries() {
      const altEntry: ProcedureEntry = {
        ...BROWSER_ENTRY,
        procedure_id: 'attendance.approve.freee',
        target: { name: 'Freee HR', origins: ['https://p.freee.co.jp'] },
        intent_phrases: ['勤怠の承認'],
      };
      stubCatalog([BROWSER_ENTRY, altEntry]);
    }

    it('calls delegateTask when Stage 1 is ambiguous and backend is real', async () => {
      const delegateFn = vi.fn().mockResolvedValue(
        JSON.stringify([
          { procedure_id: 'attendance.approve.kingoftime', confidence: 0.9, reason: 'best match' },
        ]),
      );
      const fakeBackend: ReasoningBackend = {
        ...stubReasoningBackend,
        name: 'fake',
        delegateTask: delegateFn,
      };
      registerReasoningBackend(fakeBackend);
      twoIdenticalPhraseEntries();

      const result = await resolveProcedure('勤怠の承認');
      expect(delegateFn).toHaveBeenCalled();
      expect(result.outcome).toBe('matched');
      expect(result.best?.procedure_id).toBe('attendance.approve.kingoftime');
    });

    it('returns unmatched when LLM explicitly returns empty array', async () => {
      const delegateFn = vi.fn().mockResolvedValue('[]');
      const fakeBackend: ReasoningBackend = {
        ...stubReasoningBackend,
        name: 'fake',
        delegateTask: delegateFn,
      };
      registerReasoningBackend(fakeBackend);
      twoIdenticalPhraseEntries();

      const result = await resolveProcedure('勤怠の承認');
      expect(delegateFn).toHaveBeenCalled();
      expect(result.outcome).toBe('unmatched');
    });
  });
});
