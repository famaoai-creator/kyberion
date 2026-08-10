import { describe, expect, it } from 'vitest';
import {
  checkTriggerSourceWiring,
  checkWorkerEventTypeEmitters,
  checkReflexDispatcherBinding,
  checkDaemonWatchdogCoverage,
  checkEventStoreRetention,
  checkEventDocHonesty,
  collectEventWiringSources,
  collectEventWiringViolations,
  parseConstStringArray,
  parseStringUnion,
  type EventWiringSources,
} from './check_event_wiring.js';

/**
 * EV-10: every defect this checker exists to prevent had the same shape — a
 * declaration with no wiring behind it. So each rule is tested against a
 * synthetic tree where the wiring is deliberately absent: a rule that cannot go
 * red is worse than no rule, because it certifies the thing it never checked.
 */
describe('check_event_wiring', () => {
  const sources = (files: Record<string, string>): EventWiringSources => ({ files });

  describe('parsers', () => {
    it('as const 文字列配列を読む', () => {
      expect(parseConstStringArray("export const X = ['a', 'b', 'c'] as const;", 'X')).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('文字列ユニオン型を読む', () => {
      expect(parseStringUnion("export type S = 'cron' | 'watch' | 'wake';", 'S')).toEqual([
        'cron',
        'watch',
        'wake',
      ]);
    });

    it('宣言が無ければ空配列', () => {
      expect(parseConstStringArray('nothing here', 'X')).toEqual([]);
      expect(parseStringUnion('nothing here', 'S')).toEqual([]);
    });
  });

  describe('rule: TriggerSource wiring', () => {
    it('呼び出し元の無い TriggerSource 値を検出する', () => {
      const violations = checkTriggerSourceWiring(
        sources({
          'libs/core/trigger-runner.ts':
            "export type TriggerSource = 'cron' | 'watch';\nexport function createTriggerRunner() {}\nexport function armTriggerWatch() {}",
          'scripts/some_daemon.ts': 'createTriggerRunner();',
        })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/'watch' is a dead declaration/);
    });

    it('全値に呼び出し元があれば緑', () => {
      const violations = checkTriggerSourceWiring(
        sources({
          'libs/core/trigger-runner.ts': "export type TriggerSource = 'cron' | 'watch';",
          'scripts/a.ts': 'createTriggerRunner();',
          'libs/core/b.ts': 'armTriggerWatch(id, {});',
        })
      );
      expect(violations).toEqual([]);
    });

    it('テストファイルは呼び出し元として数えない', () => {
      const violations = checkTriggerSourceWiring(
        sources({
          'libs/core/trigger-runner.ts': "export type TriggerSource = 'cron';",
          'libs/core/trigger-runner.test.ts': 'createTriggerRunner();',
        })
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe('rule: worker event emitters', () => {
    it('emit されないイベント型を検出する', () => {
      const violations = checkWorkerEventTypeEmitters(
        sources({
          'libs/core/worker-event-stream.ts':
            "export const WORKER_EVENT_TYPES = ['turn_begin', 'never_emitted'] as const;",
          'libs/core/somewhere.ts': "stream.emit('turn_begin', {});",
        })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/'never_emitted' is never emitted/);
    });
  });

  describe('rule: reflex dispatcher binding', () => {
    it('dispatcher が bind されていないエンジンを検出する', () => {
      const violations = checkReflexDispatcherBinding(
        sources({
          'libs/shared-nerve/src/reflex-engine.ts': 'public setDispatcher(fn) {}',
          'libs/shared-nerve/src/reflex-engine.test.ts': 'engine.setDispatcher(mock);',
        })
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toMatch(/setDispatcher\(\) is never called in production/);
    });

    it('production の bind があれば緑', () => {
      expect(
        checkReflexDispatcherBinding(
          sources({
            'libs/shared-nerve/src/reflex-engine.ts': 'public setDispatcher(fn) {}',
            'presence/bridge/nexus-daemon.ts': 'reflexEngine.setDispatcher(async () => {});',
          })
        )
      ).toEqual([]);
    });

    it('エンジンが存在しなければ何も要求しない', () => {
      expect(checkReflexDispatcherBinding(sources({}))).toEqual([]);
    });
  });

  describe('rule: daemon watchdog coverage', () => {
    it('heartbeat を出すが監視対象でない daemon を検出する', () => {
      const violations = checkDaemonWatchdogCoverage(
        sources({
          'scripts/daemon_watchdog.ts': "const DEFAULT_DAEMONS = ['a-daemon'];",
          'scripts/b_daemon.ts': "recordDaemonHeartbeat('b-daemon', { status: 'running' });",
        })
      );
      expect(violations.some((v) => v.includes("'b-daemon'"))).toBe(true);
    });

    it('heartbeat を全く出さない daemon スクリプトを検出する', () => {
      const violations = checkDaemonWatchdogCoverage(
        sources({
          'scripts/daemon_watchdog.ts': 'const DEFAULT_DAEMONS = [];',
          'scripts/silent_daemon.ts': 'while (true) {}',
        })
      );
      expect(violations.some((v) => v.includes('records no heartbeat'))).toBe(true);
    });
  });

  describe('rule: event store retention', () => {
    it('宣言の無いイベントストアを検出する', () => {
      const violations = checkEventStoreRetention(
        sources({
          'knowledge/product/governance/storage-retention-catalog.json': JSON.stringify({
            entries: [{ path: 'active/shared/tmp' }],
          }),
        })
      );
      // All three event-store prefixes are undeclared here.
      expect(violations).toHaveLength(3);
    });

    it('親ディレクトリの宣言で覆われていれば緑', () => {
      const violations = checkEventStoreRetention(
        sources({
          'knowledge/product/governance/storage-retention-catalog.json': JSON.stringify({
            entries: [
              { path: 'active/shared/observability' },
              { path: 'active/shared/coordination' },
              { path: 'presence/bridge' },
            ],
          }),
        })
      );
      expect(violations).toEqual([]);
    });

    it('壊れたカタログは緑にせず違反として報告する', () => {
      const violations = checkEventStoreRetention(
        sources({ 'knowledge/product/governance/storage-retention-catalog.json': '{ not json' })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/unparseable/);
    });
  });

  describe('rule: doc honesty', () => {
    it('実装が消えた機能を説明する文書を検出する', () => {
      const violations = checkEventDocHonesty(
        sources({
          'docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md': '## 反射設計図 (Reflex ADF)',
          // reflex-engine.ts deliberately absent
        })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/implementation has been removed/);
    });

    it('実装が在れば記述を許す', () => {
      expect(
        checkEventDocHonesty(
          sources({
            'docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md': '## 反射設計図 (Reflex ADF)',
            'libs/shared-nerve/src/reflex-engine.ts': 'export const reflexEngine = {};',
          })
        )
      ).toEqual([]);
    });
  });

  it('実リポジトリで全ルールが緑（EV-01〜09 の受入条件）', () => {
    expect(collectEventWiringViolations(collectEventWiringSources())).toEqual([]);
  });
});
