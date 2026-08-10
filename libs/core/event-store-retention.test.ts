import { describe, it, expect } from 'vitest';
import {
  loadRetentionCatalog,
  eventStoreRetentionRules,
  coveredEventStoreDirs,
  retentionEntryForPath,
  EVENT_STORE_PREFIXES,
} from './storage-retention-catalog.js';

/**
 * EV-06: the append-only event stores sat outside every janitor scan root, so
 * they were neither TTL-governed nor reported as uncovered — the one state the
 * catalog's own contract says must not exist ("never a silent forever
 * retention"). These assert the declarations that close that hole.
 */
describe('event store retention (EV-06)', () => {
  const catalog = loadRetentionCatalog();

  it('全イベントストア接頭辞に retention 宣言がある', () => {
    for (const prefix of EVENT_STORE_PREFIXES) {
      const entry = retentionEntryForPath(catalog, prefix);
      expect(entry, `no retention entry covers ${prefix}`).not.toBeNull();
    }
  });

  it('各接頭辞が TTL ルールを生む（review_required で止まっていない）', () => {
    const rules = eventStoreRetentionRules(catalog);
    for (const prefix of EVENT_STORE_PREFIXES) {
      const covering = rules.filter(
        (rule) => prefix === rule.repoRelativeDir || prefix.startsWith(`${rule.repoRelativeDir}/`)
      );
      expect(covering.length, `${prefix} has no deletion rule`).toBeGreaterThan(0);
      for (const rule of covering) expect(rule.ttlMs).toBeGreaterThan(0);
    }
  });

  it('具体エントリが親の catch-all より優先される（longest-prefix）', () => {
    // channels/ is high-volume surface traffic on a 30d floor; the residual
    // observability rule is 90d evidence. If the parent won, conversational
    // logs would be retained three times as long as intended.
    const channels = retentionEntryForPath(catalog, 'active/shared/observability/channels');
    const residual = retentionEntryForPath(catalog, 'active/shared/observability');
    expect(channels?.path).toBe('active/shared/observability/channels');
    expect(residual?.path).toBe('active/shared/observability');
    expect(channels?.ttl_days).toBeLessThan(residual?.ttl_days as number);
  });

  it('observability 直下のファイルは残余ルールに帰属する', () => {
    // ops-alerts.jsonl is a file, and the catalog models directories — so it
    // must resolve through the parent rather than needing its own entry.
    const entry = retentionEntryForPath(catalog, 'active/shared/observability/ops-alerts.jsonl');
    expect(entry?.path).toBe('active/shared/observability');
    expect(entry?.audit).toBe(true);
  });

  it('監査対象のイベントストアには audit フラグが立っている', () => {
    for (const p of [
      'active/shared/observability/mission-control',
      'active/shared/observability',
    ]) {
      expect(retentionEntryForPath(catalog, p)?.audit, `${p} must leave a deletion audit`).toBe(
        true
      );
    }
  });

  it('coveredEventStoreDirs が宣言済みディレクトリを返す', () => {
    const covered = coveredEventStoreDirs(catalog);
    for (const prefix of EVENT_STORE_PREFIXES) expect(covered.has(prefix)).toBe(true);
  });
});
