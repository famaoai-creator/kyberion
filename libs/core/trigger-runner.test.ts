import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  TriggerRunner,
  assertNoEscalation,
  normalizeTriggerRecord,
  releaseTriggerLeaderLease,
  planTriggerStoreRotation,
  resetTriggerStoreWindowFullState,
  rotateTriggerStore,
  resolveCurrentTriggerAuthority,
  runWakeTrigger,
  withTriggerLeaderLease,
} from './trigger-runner.js';
import { auditChain } from './governance/audit-chain.js';
import { deriveTraceOrigin } from './analysis/trace.js';
import * as path from 'node:path';

describe('QM-02 trigger runner', () => {
  const stores: string[] = [];
  const authority = { authority_role: 'chronos_gateway', level: 40, tenant_slug: 'common' };

  afterEach(() => {
    for (const store of stores.splice(0)) {
      if (safeExistsSync(store)) safeUnlinkSync(store);
    }
  });

  function runner(): TriggerRunner {
    const store = pathResolver.sharedTmp(`qm02-trigger-${randomUUID()}.jsonl`);
    stores.push(store);
    return new TriggerRunner({ storePath: store, authorityResolver: (snapshot) => snapshot });
  }

  it('routes cron, watch, and wake through one idempotent delivery contract', async () => {
    const triggerRunner = runner();
    const delivered = vi.fn(async () => 'delivery-1');

    for (const source of ['cron', 'watch', 'wake'] as const) {
      const request = {
        idempotencyKey: `qm02:${source}:1`,
        createdBy: authority,
      };
      const first =
        source === 'wake'
          ? await runWakeTrigger(triggerRunner, request, delivered)
          : await triggerRunner.run({ ...request, source }, delivered);
      const duplicate = await triggerRunner.run(
        {
          idempotencyKey: `qm02:${source}:1`,
          source,
          createdBy: authority,
        },
        delivered
      );
      expect(first.status).toBe('delivered');
      expect(duplicate.status).toBe('duplicate');
    }

    expect(delivered).toHaveBeenCalledTimes(3);
    expect(triggerRunner.records()).toHaveLength(6);
  });

  it('WI-13 review: a trace built inside a cron delivery derives scheduled, even while deliveries overlap', async () => {
    const triggerRunner = runner();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const origins: Record<string, string> = {};
    // Clean env (no VITEST/CI) so only the ambient trigger scope decides.
    const cronRun = triggerRunner.run(
      { idempotencyKey: 'wi13:cron:1', source: 'cron', createdBy: authority },
      async () => {
        await gate; // stay open while the watch delivery runs
        origins.cron = deriveTraceOrigin(undefined, {});
        return 'cron-delivery';
      }
    );
    const watchRun = triggerRunner.run(
      { idempotencyKey: 'wi13:watch:1', source: 'watch', createdBy: authority },
      async () => {
        origins.watch = deriveTraceOrigin(undefined, {});
        release();
        return 'watch-delivery';
      }
    );
    await Promise.all([cronRun, watchRun]);
    expect(origins).toEqual({ cron: 'scheduled', watch: 'interactive' });
    expect(deriveTraceOrigin(undefined, {})).toBe('interactive');
  });

  it('rejects authority and tenant escalation before delivery', async () => {
    expect(() =>
      assertNoEscalation(authority, {
        authority_role: 'mission_controller',
        level: 50,
        tenant_slug: 'common',
      })
    ).toThrow(/escalation denied/);

    const triggerRunner = runner();
    const delivered = vi.fn();
    const result = await triggerRunner.run(
      {
        idempotencyKey: 'qm02:escalated',
        source: 'wake',
        createdBy: authority,
        requestedAuthority: {
          authority_role: 'other-tenant',
          level: 40,
          tenant_slug: 'other',
        },
      },
      delivered
    );

    expect(result.status).toBe('rejected');
    expect(delivered).not.toHaveBeenCalled();
  });

  it('rejects a trigger authority that is not bound to the active execution role', async () => {
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'software_developer';
    try {
      const store = pathResolver.sharedTmp(`qm02-bound-${randomUUID()}.jsonl`);
      stores.push(store);
      const triggerRunner = new TriggerRunner({ storePath: store });
      const result = await triggerRunner.run(
        { idempotencyKey: 'qm02:unbound', source: 'wake', createdBy: authority },
        async () => 'should-not-deliver'
      );
      expect(result.status).toBe('rejected');
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });

  it('preserves tenant scope when deriving the current trigger authority', () => {
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'chronos_gateway';
    try {
      const snapshot = resolveCurrentTriggerAuthority('tenant-a');
      expect(snapshot).toMatchObject({ tenant_slug: 'tenant-a' });
      expect(() =>
        assertNoEscalation(snapshot, {
          authority_role: snapshot.authority_role,
          level: snapshot.level,
          tenant_slug: 'tenant-b',
        })
      ).toThrow(/tenant scope escalation denied/);
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });

  it('retries a failed delivery with the same delivery id', async () => {
    const triggerRunner = runner();
    const delivered = vi
      .fn<(input: { deliveryId: string }) => Promise<string>>()
      .mockRejectedValueOnce(new Error('delivery unavailable'))
      .mockResolvedValueOnce('delivery-1');

    const first = await triggerRunner.run(
      { idempotencyKey: 'qm02:failed', source: 'cron', createdBy: authority },
      delivered
    );
    const second = await triggerRunner.run(
      { idempotencyKey: 'qm02:failed', source: 'cron', createdBy: authority },
      delivered
    );

    expect(first.status).toBe('failed');
    expect(second.status).toBe('delivered');
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls[0]?.[0].deliveryId).toBe(delivered.mock.calls[1]?.[0].deliveryId);
  });

  it('claims once across concurrent runners sharing the same store', async () => {
    const first = runner();
    const store = (first as unknown as { storePath: string }).storePath;
    const second = new TriggerRunner({
      storePath: store,
      authorityResolver: (snapshot) => snapshot,
    });
    let releaseDelivery!: () => void;
    const deliveryBlocked = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const delivered = vi.fn(async () => {
      await deliveryBlocked;
      return 'delivery-concurrent';
    });

    const firstRun = first.run(
      { idempotencyKey: 'qm02:concurrent', source: 'wake', createdBy: authority },
      delivered
    );
    // The first run owns the claim once its delivery has started; wait for
    // that instead of a fixed sleep that a slow runner can outlast.
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    const secondRun = second.run(
      { idempotencyKey: 'qm02:concurrent', source: 'wake', createdBy: authority },
      delivered
    );
    const duplicate = await secondRun;
    releaseDelivery();
    const deliveredReceipt = await firstRun;

    expect(duplicate.status).toBe('duplicate');
    expect(deliveredReceipt.status).toBe('delivered');
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered receipt when audit persistence fails', async () => {
    const triggerRunner = runner();
    const auditSpy = vi.spyOn(auditChain, 'record').mockImplementationOnce(() => {
      throw new Error('audit unavailable');
    });
    try {
      const result = await triggerRunner.run(
        { idempotencyKey: 'qm02:audit-failure', source: 'wake', createdBy: authority },
        async () => 'delivery-audit-safe'
      );

      expect(result.status).toBe('delivered');
      expect(triggerRunner.records().at(-1)?.status).toBe('delivered');
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('compacts the delivery store before it reaches the read limit', async () => {
    const store = pathResolver.sharedTmp(`qm02-compact-${randomUUID()}.jsonl`);
    stores.push(store);
    const triggerRunner = new TriggerRunner({
      storePath: store,
      maxStoreBytes: 64 * 1024,
      authorityResolver: (snapshot) => snapshot,
    });
    const seed = JSON.stringify({
      idempotencyKey: 'qm02:compact:seed',
      source: 'wake',
      status: 'failed',
      reason: 'old_failure',
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt: new Date().toISOString(),
    });
    safeWriteFile(store, `${Array.from({ length: 3000 }, () => seed).join('\n')}\n`);
    await triggerRunner.run(
      { idempotencyKey: 'qm02:compact:new', source: 'wake', createdBy: authority },
      async () => 'delivery-new'
    );
    expect(safeStat(store).size).toBeLessThan(64 * 1024);
    for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
  });

  function rotatedSegments(store: string): string[] {
    const stem = path.basename(store).replace(/\.jsonl$/u, '');
    return safeReaddir(path.dirname(store))
      .filter((name) => name.startsWith(`${stem}-`))
      .map((name) => path.join(path.dirname(store), name));
  }

  function journalLine(
    key: string,
    recordedAt: string,
    status = 'delivered',
    source = 'cron'
  ): string {
    return JSON.stringify({
      idempotencyKey: key,
      source,
      status,
      deliveryId: key,
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt,
    });
  }

  it('handles a journal past the 5MB read cap without throwing and still dedupes', async () => {
    const store = pathResolver.sharedTmp(`qm02-oversize-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const recent = now.toISOString();
    // Minute-scoped keys never compact; this is the shape that crash-looped chronos.
    const filler = Array.from({ length: 24_000 }, (_, i) =>
      journalLine(`daemon-recovery:chronos:stale:${i}`, recent)
    );
    filler.push(journalLine('cron:recent-job:minute', recent));
    safeWriteFile(store, `${filler.join('\n')}\n`);
    expect(safeStat(store).size).toBeGreaterThan(5 * 1024 * 1024);
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        authorityResolver: (snapshot) => snapshot,
        now: () => now,
      });
      const deliver = vi.fn(async () => 'delivery');

      const duplicate = await triggerRunner.run(
        { idempotencyKey: 'cron:recent-job:minute', source: 'cron', createdBy: authority },
        deliver
      );
      expect(duplicate.status).toBe('duplicate');
      expect(deliver).not.toHaveBeenCalled();

      const fresh = await triggerRunner.run(
        { idempotencyKey: 'cron:new-job:minute', source: 'cron', createdBy: authority },
        deliver
      );
      expect(fresh.status).toBe('delivered');
      expect(deliver).toHaveBeenCalledTimes(1);
      // Rotated inline to under the cap; the full history went to a segment.
      expect(safeStat(store).size).toBeLessThan(4 * 1024 * 1024);
      expect(rotatedSegments(store)).toHaveLength(1);

      const again = await triggerRunner.run(
        { idempotencyKey: 'cron:recent-job:minute', source: 'cron', createdBy: authority },
        deliver
      );
      expect(again.status).toBe('duplicate');
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  it('rotation keeps the recent dedupe window and in-flight claims, archiving the rest', async () => {
    const store = pathResolver.sharedTmp(`qm02-window-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now.getTime() - 60 * 1000).toISOString();
    const inFlight = JSON.stringify({
      idempotencyKey: 'wake:in-flight',
      source: 'wake',
      status: 'failed',
      reason: 'delivery_pending',
      deliveryId: 'wake:in-flight',
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt: stale,
      claimId: 'claim-1',
      claimOwnerPid: process.pid,
      claimExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      attempt: 1,
    });
    const lines = [
      journalLine('cron:stale-job', stale),
      inFlight,
      ...Array.from({ length: 600 }, (_, i) => journalLine(`cron:filler:${i}`, recent)),
      journalLine('cron:recent-job', recent),
    ];
    safeWriteFile(store, `${lines.join('\n')}\n`);
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        maxStoreBytes: 64 * 1024,
        authorityResolver: (snapshot) => snapshot,
        now: () => now,
      });
      const deliver = vi.fn(async () => 'delivery');
      await triggerRunner.run(
        { idempotencyKey: 'cron:trigger-rotation', source: 'cron', createdBy: authority },
        deliver
      );

      const live = String(safeReadFile(store, { encoding: 'utf8' }));
      expect(safeStat(store).size).toBeLessThanOrEqual(32 * 1024 + 2048);
      expect(live).toContain('cron:recent-job');
      expect(live).toContain('wake:in-flight');
      expect(live).not.toContain('cron:stale-job');
      expect(live).not.toContain('cron:filler:0"');

      const [segment] = rotatedSegments(store);
      expect(path.basename(segment)).toMatch(/-\d{8}-\d{6}(-\d+)?\.jsonl$/u);
      expect(String(safeReadFile(segment, { encoding: 'utf8' }))).toContain('cron:stale-job');

      const recentAgain = await triggerRunner.run(
        { idempotencyKey: 'cron:recent-job', source: 'cron', createdBy: authority },
        deliver
      );
      const pending = await triggerRunner.run(
        { idempotencyKey: 'wake:in-flight', source: 'wake', createdBy: authority },
        deliver
      );
      expect(recentAgain.status).toBe('duplicate');
      expect(pending.status).toBe('duplicate');
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  it('keeps stable keys for the whole dedupe window under byte pressure, trimming oldest cron keys first', async () => {
    const store = pathResolver.sharedTmp(`qm02-stable-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const day = 24 * 60 * 60 * 1000;
    const lines = [
      journalLine('mission-admission:MSN-EXPIRED', ago(8 * day), 'delivered', 'wake'),
      // Stable keys six days old: older than every cron key below, yet inside the window.
      ...Array.from({ length: 20 }, (_, i) =>
        journalLine(`reflex:r-${i}:stimulus-${i}`, ago(6 * day), 'delivered', 'wake')
      ),
      journalLine('mission-admission:MSN-OLD', ago(6 * day), 'delivered', 'wake'),
      ...Array.from({ length: 600 }, (_, i) =>
        journalLine(`cron:filler-${i}:2026-10-01T00:00`, ago(day - i * 1000))
      ),
    ];
    safeWriteFile(store, `${lines.join('\n')}\n`);
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        maxStoreBytes: 64 * 1024,
        authorityResolver: (snapshot) => snapshot,
        now: () => now,
      });
      const deliver = vi.fn(async () => 'delivery');
      await triggerRunner.run(
        { idempotencyKey: 'wake:rotate-now', source: 'wake', createdBy: authority },
        deliver
      );
      const live = String(safeReadFile(store, { encoding: 'utf8' }));
      expect(safeStat(store).size).toBeLessThanOrEqual(32 * 1024 + 2048);
      for (let i = 0; i < 20; i++) expect(live).toContain(`reflex:r-${i}:stimulus-${i}`);
      expect(live).toContain('mission-admission:MSN-OLD');
      expect(live).not.toContain('mission-admission:MSN-EXPIRED');
      // The oldest cron receipt went first; the newest survived.
      expect(live).not.toContain('"cron:filler-0:2026-10-01T00:00"');
      expect(live).toContain('"cron:filler-599:2026-10-01T00:00"');
      expect(live).toContain('wake:rotate-now');

      const again = await triggerRunner.run(
        { idempotencyKey: 'mission-admission:MSN-OLD', source: 'wake', createdBy: authority },
        deliver
      );
      expect(again.status).toBe('duplicate');
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  it('does not rotate when stable keys inside the window alone fill the budget', async () => {
    const store = pathResolver.sharedTmp(`qm02-stable-full-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const lines = Array.from({ length: 300 }, (_, i) =>
      journalLine(`continuous-owner:action-${i}`, recent, 'delivered', 'wake')
    );
    safeWriteFile(store, `${lines.join('\n')}\n`);
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        maxStoreBytes: 64 * 1024,
        authorityResolver: (snapshot) => snapshot,
        now: () => now,
      });
      const before = safeStat(store).size;
      expect(before).toBeGreaterThan(64 * 1024);
      const receipt = await triggerRunner.run(
        { idempotencyKey: 'wake:append-anyway', source: 'wake', createdBy: authority },
        async () => 'delivery'
      );
      expect(receipt.status).toBe('delivered');
      expect(rotatedSegments(store)).toHaveLength(0);
      const live = String(safeReadFile(store, { encoding: 'utf8' }));
      expect(live).toContain('continuous-owner:action-0"');
      expect(live).toContain('wake:append-anyway');
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  describe('window-full backoff', () => {
    const minute = 60_000;
    const T0 = new Date('2026-11-01T00:00:00.000Z');
    // Inside the window at T0, aged out five minutes later.
    const nearExpiry = new Date(T0.getTime() - 7 * 24 * 60 * minute + 5 * minute).toISOString();

    function windowFullStore(): { store: string; at: (offsetMin: number) => TriggerRunner } {
      resetTriggerStoreWindowFullState();
      const store = pathResolver.sharedTmp(`qm02-backoff-${randomUUID()}.jsonl`);
      stores.push(store);
      const lines = Array.from({ length: 300 }, (_, i) =>
        journalLine(`continuous-owner:act-${i}`, nearExpiry, 'delivered', 'wake')
      );
      safeWriteFile(store, `${lines.join('\n')}\n`);
      return {
        store,
        at: (offsetMin) =>
          new TriggerRunner({
            storePath: store,
            maxStoreBytes: 64 * 1024,
            authorityResolver: (snapshot) => snapshot,
            now: () => new Date(T0.getTime() + offsetMin * minute),
          }),
      };
    }

    function captureWarnings(): { count: () => number; restore: () => void } {
      const lines: string[] = [];
      const spies = [process.stderr, process.stdout].map((stream) =>
        vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          lines.push(String(chunk));
          return true;
        })
      );
      return {
        count: () => lines.filter((line) => line.includes('[TRIGGER_STORE_WINDOW_FULL]')).length,
        restore: () => spies.forEach((spy) => spy.mockRestore()),
      };
    }

    const wake = (key: string) => ({
      idempotencyKey: key,
      source: 'wake' as const,
      createdBy: authority,
    });

    it('skips the re-parse until an hour passed and warns once per hour', async () => {
      const { store, at } = windowFullStore();
      const warnings = captureWarnings();
      try {
        await at(0).run(wake('wake:a'), async () => 'd');
        await at(1).run(wake('wake:b'), async () => 'd');
        expect(warnings.count()).toBe(1);
        // At +10 min the old receipts aged out, so a compaction would now rotate —
        // but the journal has not regrown and the hour has not passed: skipped.
        await at(10).run(wake('wake:c'), async () => 'd');
        expect(rotatedSegments(store)).toHaveLength(0);
        await at(61).run(wake('wake:d'), async () => 'd');
        expect(rotatedSegments(store)).toHaveLength(1);
        expect(String(safeReadFile(store, { encoding: 'utf8' }))).not.toContain('act-0"');
        expect(warnings.count()).toBe(1);
      } finally {
        warnings.restore();
        for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
      }
    });

    it('retries early when the journal shrank (rotated by another process)', async () => {
      const { store, at } = windowFullStore();
      const warnings = captureWarnings();
      try {
        await at(0).run(wake('wake:a'), async () => 'd');
        const lines = Array.from({ length: 220 }, (_, i) =>
          journalLine(`continuous-owner:act-${i}`, nearExpiry, 'delivered', 'wake')
        );
        safeWriteFile(store, `${lines.join('\n')}\n`);
        expect(safeStat(store).size).toBeGreaterThan(64 * 1024);
        await at(10).run(wake('wake:b'), async () => 'd');
        expect(rotatedSegments(store)).toHaveLength(1);
      } finally {
        warnings.restore();
        for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
      }
    });

    it('retries early once the journal regrew by 256KB', async () => {
      const { store, at } = windowFullStore();
      const warnings = captureWarnings();
      try {
        await at(0).run(wake('wake:a'), async () => 'd');
        const old = new Date(T0.getTime() - 30 * 24 * 60 * minute).toISOString();
        const filler = Array.from({ length: 900 }, (_, i) =>
          journalLine(`continuous-owner:old-${i}`, old, 'delivered', 'wake')
        ).join('\n');
        safeWriteFile(store, `${String(safeReadFile(store, { encoding: 'utf8' }))}${filler}\n`);
        await at(10).run(wake('wake:b'), async () => 'd');
        expect(rotatedSegments(store)).toHaveLength(1);
      } finally {
        warnings.restore();
        for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
      }
    });
  });

  it('operator rotation keeps in-flight claims, the newest N stable keys and recent cron receipts', async () => {
    const store = pathResolver.sharedTmp(`qm02-rotate-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const pending = JSON.stringify({
      idempotencyKey: 'wake:pending',
      source: 'wake',
      status: 'failed',
      reason: 'delivery_pending',
      deliveryId: 'wake:pending',
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt: ago(60_000),
      claimId: 'c',
      claimOwnerPid: process.pid,
      claimExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      attempt: 1,
    });
    const lines = [
      pending,
      ...Array.from({ length: 5 }, (_, i) =>
        journalLine(`reflex:r:${i}`, ago((10 - i) * 60_000), 'delivered', 'wake')
      ),
      journalLine('cron:job:2026-11-01T00:00', ago(2 * 60_000)),
      journalLine('cron:job:2026-10-31T00:00', ago(2 * 60 * 60_000)),
    ];
    safeWriteFile(store, `${lines.join('\n')}\n`);
    try {
      const plan = planTriggerStoreRotation({ storePath: store, keepStable: 2, now });
      expect(plan.kept).toEqual({ in_flight: 1, stable: 2, recent_cron: 1 });
      expect(plan.dropped_keys).toBe(4);
      expect(safeStat(store).size).toBe(plan.size_bytes);

      const wrapped = vi.fn(<T>(effect: () => T) => effect());
      const result = await rotateTriggerStore({ storePath: store, keepStable: 2, now }, wrapped);
      expect(wrapped).toHaveBeenCalledTimes(1);
      const live = String(safeReadFile(store, { encoding: 'utf8' }));
      expect(live).toContain('wake:pending');
      expect(live).toContain('reflex:r:4');
      expect(live).toContain('reflex:r:3');
      expect(live).not.toContain('reflex:r:2');
      expect(live).toContain('cron:job:2026-11-01T00:00');
      expect(live).not.toContain('cron:job:2026-10-31T00:00');
      expect(rotatedSegments(store).map((s) => path.basename(s))).toContain(
        path.basename(result.segment_path)
      );
      expect(String(safeReadFile(rotatedSegments(store)[0], { encoding: 'utf8' }))).toContain(
        'reflex:r:0'
      );
      await expect(rotateTriggerStore({ storePath: store, keepStable: -1, now })).rejects.toThrow(
        /keep-stable/
      );
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  it('drops pending claims whose lease expired longer ago than the dedupe window', async () => {
    const store = pathResolver.sharedTmp(`qm02-dead-claim-${randomUUID()}.jsonl`);
    stores.push(store);
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const claim = (key: string, expiresAgoMs: number) =>
      JSON.stringify({
        idempotencyKey: key,
        source: 'wake',
        status: 'failed',
        reason: 'delivery_pending',
        deliveryId: key,
        createdBy: authority,
        requestedAuthority: authority,
        recordedAt: new Date(now.getTime() - expiresAgoMs - 15 * 60_000).toISOString(),
        claimId: `claim-${key}`,
        claimOwnerPid: 999_999_999,
        claimExpiresAt: new Date(now.getTime() - expiresAgoMs).toISOString(),
        attempt: 1,
      });
    const lines = [
      claim('wake:dead-claim', 8 * day),
      claim('wake:recently-expired-claim', day),
      ...Array.from({ length: 600 }, (_, i) =>
        journalLine(`cron:filler:${i}`, new Date(now.getTime() - 60_000).toISOString())
      ),
    ];
    safeWriteFile(store, `${lines.join('\n')}\n`);
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        maxStoreBytes: 64 * 1024,
        authorityResolver: (snapshot) => snapshot,
        now: () => now,
      });
      await triggerRunner.run(
        { idempotencyKey: 'wake:rotate-claims', source: 'wake', createdBy: authority },
        async () => 'delivery'
      );
      const live = String(safeReadFile(store, { encoding: 'utf8' }));
      expect(live).not.toContain('wake:dead-claim');
      expect(live).toContain('wake:recently-expired-claim');
      expect(String(safeReadFile(rotatedSegments(store)[0], { encoding: 'utf8' }))).toContain(
        'wake:dead-claim'
      );
    } finally {
      for (const segment of rotatedSegments(store)) safeUnlinkSync(segment);
    }
  });

  it('rejects a delivery store outside the repository', () => {
    expect(() => new TriggerRunner({ storePath: '/tmp/trigger-deliveries.jsonl' })).toThrow(
      /outside the repository root/
    );
  });

  it('skips malformed persisted receipts before idempotency evaluation', () => {
    const valid = {
      idempotencyKey: 'qm02:persisted',
      source: 'wake',
      status: 'delivered',
      createdBy: authority,
      recordedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(normalizeTriggerRecord(valid)).toMatchObject({ idempotencyKey: 'qm02:persisted' });
    expect(normalizeTriggerRecord([])).toBeNull();
    expect(normalizeTriggerRecord({ ...valid, status: 'unknown' })).toBeNull();
    expect(normalizeTriggerRecord({ ...valid, createdBy: [] })).toBeNull();
    expect(normalizeTriggerRecord({ ...valid, recordedAt: 'not-a-date' })).toBeNull();
  });

  it('rejects a delivery store replaced by a directory', () => {
    const store = pathResolver.sharedTmp('qm02-directory-' + randomUUID() + '.jsonl');
    safeMkdir(store, { recursive: true });
    try {
      const triggerRunner = new TriggerRunner({
        storePath: store,
        authorityResolver: (snapshot) => snapshot,
      });

      expect(() => triggerRunner.records()).toThrow(
        '[TRIGGER_STORE_INVALID] delivery store must be a regular file'
      );
    } finally {
      safeRmSync(store, { recursive: true, force: true });
    }
  });
});

describe('trigger leader lease shutdown release', () => {
  it('releases a lease held by an abandoned in-flight tick so the next leader can run', async () => {
    const leaderId = `lease-release-test-${process.pid}-${randomUUID()}`;
    let releaseTick!: () => void;
    const abandoned = withTriggerLeaderLease(
      leaderId,
      () => new Promise<string>((resolve) => (releaseTick = () => resolve('late')))
    );
    // Lease is held: a second tick is skipped.
    await expect(withTriggerLeaderLease(leaderId, async () => 'second')).resolves.toBeUndefined();

    releaseTriggerLeaderLease(leaderId);
    await expect(withTriggerLeaderLease(leaderId, async () => 'next')).resolves.toBe('next');

    releaseTick();
    await expect(abandoned).resolves.toBe('late');
  });
});
