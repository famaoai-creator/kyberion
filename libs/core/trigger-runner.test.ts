import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeStat, safeUnlinkSync, safeWriteFile } from './secure-io.js';
import { TriggerRunner, assertNoEscalation, runWakeTrigger } from './trigger-runner.js';
import { auditChain } from './audit-chain.js';

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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
  });
});
