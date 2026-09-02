import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditChain } from './audit-chain.js';
import {
  CloudflareOsControlPlane,
  assertImmutableAuthConfig,
  assertAuthConfigMutationSource,
  AUTH_CONFIG_BOUNDARY_INVENTORY,
  isConstantTimeEqual,
  normalizeGovernedCodeEnvelope,
} from './cloudflare-os-control-plane.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeUnlinkSync, safeWriteFile } from './secure-io.js';

function createPlane() {
  return new CloudflareOsControlPlane({ persist: false });
}

function action(overrides: Record<string, unknown> = {}) {
  return {
    missionId: 'mission-os-test',
    submittedBy: 'operator',
    op: 'test:write',
    params: { value: 'ok' },
    apply: ({ value }: { value: string }) => ({ id: `real-${value}` }),
    ...overrides,
  } as never;
}

function approval(record: { payloadHash: string; effectBinding: string }) {
  return {
    resolvedBy: 'human:famao',
    decidedByType: 'human' as const,
    authenticated: true,
    payloadHash: record.payloadHash,
    effectBinding: record.effectBinding,
  };
}

async function grantIntroduction(
  plane: CloudflareOsControlPlane,
  input: {
    missionId: string;
    service: string;
    resourceRef: string;
    scope: 'read' | 'write';
  }
) {
  const record = plane.requestResourceIntroduction({ ...input, requestedBy: 'operator' });
  plane.decideHeldAction(record.id, 'approved', approval(record));
  return plane.applyHeldAction(record.id);
}

const gadgetReadOperation = {
  name: 'read_summary',
  description: 'Read a bounded summary.',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  effect: 'read' as const,
  capabilityResource: 'knowledge:gadget',
  governedCode: '({ summary: bindings.input.query })',
  introduction: { service: 'knowledge', resourceRef: 'gadget' },
  observation: {
    tier: 'confidential' as const,
    purpose: 'Read the bounded gadget summary.',
    summary: 'Gadget summary read.',
  },
};

describe('Cloudflare OS adoption control plane', () => {
  it('accepts only an object envelope with an explicit value field', () => {
    expect(normalizeGovernedCodeEnvelope([])).toBeUndefined();
    expect(normalizeGovernedCodeEnvelope({})).toBeUndefined();
    expect(normalizeGovernedCodeEnvelope({ value: null, value_undefined: true })).toEqual({
      value: undefined,
    });
    expect(normalizeGovernedCodeEnvelope({ value: 3 })).toEqual({ value: 3 });
  });

  it('OS-01 submits, approves, applies exactly once and requires attribution', async () => {
    const plane = createPlane();
    let applications = 0;
    const record = plane.submitHeldAction(
      action({
        apply: () => {
          applications += 1;
          return 'done';
        },
      })
    );
    expect(() =>
      plane.decideHeldAction(record.id, 'approved', {
        ...approval(record),
        resolvedBy: 'attacker',
        decidedByType: 'service',
        authenticated: false,
      })
    ).toThrow('authenticated human');
    await expect(plane.applyHeldAction(record.id)).rejects.toThrow('not approved');
    plane.decideHeldAction(record.id, 'approved', approval(record));
    await plane.applyHeldAction(record.id);
    await plane.applyHeldAction(record.id);
    expect(applications).toBe(1);
    expect(plane.getHeldAction(record.id)?.status).toBe('applied');
  });

  it('projects held actions without exposing executor payloads', () => {
    const plane = createPlane();
    const secret = 'surface-must-not-see-this';
    const record = plane.submitHeldAction(
      action({ id: 'surface-summary-action', params: { token: secret } })
    );

    const summary = plane.getHeldActionSummary(record.id);
    expect(summary).toMatchObject({
      id: record.id,
      missionId: 'mission-os-test',
      status: 'pending',
      payloadHash: record.payloadHash,
    });
    expect(summary).not.toHaveProperty('params');
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(plane.listHeldActionSummaries('other-mission')).toEqual([]);
  });

  it('can restore for a read-only adapter without writing a recovery audit', () => {
    const statePath = pathResolver.shared('tmp/cloudflare-os-read-only-restore-test.json');
    safeWriteFile(statePath, '{not-json', { encoding: 'utf8', mkdir: true });
    const recordSpy = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);

    try {
      const plane = new CloudflareOsControlPlane({
        statePath,
        auditRestoreFailures: false,
      });
      expect(plane.listObservations()).toEqual([]);
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      recordSpy.mockRestore();
      safeUnlinkSync(statePath);
    }
  });

  it('rejects malformed persisted authority records without partial restore', () => {
    const statePath = pathResolver.sharedTmp('cloudflare-os-malformed-state-test.json');
    try {
      safeWriteFile(
        statePath,
        JSON.stringify({
          version: 1,
          held: [{ id: 'malformed-held', status: 'approved' }],
          introductions: [],
          observations: [
            {
              id: 'observation-that-must-not-restore',
              missionId: 'mission-malformed',
              service: 'knowledge',
              resourceRef: 'secret',
              tier: 'personal',
              purpose: 'test',
              summary: 'test',
              observedAt: new Date().toISOString(),
            },
          ],
          autoRules: [],
          capabilities: [],
          threadCapabilities: {},
          blueprints: [],
          network: [],
          gadgets: [],
        })
      );
      const plane = new CloudflareOsControlPlane({ statePath, auditRestoreFailures: false });

      expect(plane.getHeldAction('malformed-held')).toBeUndefined();
      expect(plane.listObservations()).toEqual([]);
    } finally {
      safeUnlinkSync(statePath);
    }
  });

  it('OS-02 simulates provisional results and blocks unfinished missions', async () => {
    const plane = createPlane();
    const record = plane.submitHeldAction(
      action({
        simulatable: true,
        simulate: () => ({ provisionalRefs: ['~1'], value: { id: '~1' }, simulated: true }),
      })
    );
    expect(record.simulation?.simulated).toBe(true);
    expect(() => plane.assertMissionFinishable('mission-os-test')).toThrow(
      'unresolved provisional'
    );
    plane.decideHeldAction(record.id, 'approved', approval(record));
    await plane.drainHeldActions('mission-os-test');
    expect(() => plane.assertMissionFinishable('mission-os-test')).not.toThrow();
  });

  it('OS-03 enforces introductions with expiry and approval flow', async () => {
    const plane = createPlane();
    const request = plane.requestResourceIntroduction({
      missionId: 'mission-os-test',
      service: 'slack',
      resourceRef: 'team:T1',
      scope: 'write',
      requestedBy: 'worker',
    });
    expect(() =>
      plane.enforceIntroduction({
        missionId: 'mission-os-test',
        service: 'slack',
        resourceRef: 'team:T1',
        scope: 'write',
      })
    ).toThrow('introduction required');
    plane.decideHeldAction(request.id, 'approved', approval(request));
    await plane.applyHeldAction(request.id);
    expect(
      plane.enforceIntroduction({
        missionId: 'mission-os-test',
        service: 'slack',
        resourceRef: 'team:T1',
        scope: 'write',
      })
    ).toBe(true);
  });

  it('OS-04/05 records observations and enforces taint-aware egress', () => {
    const plane = createPlane();
    plane.recordObservation({
      missionId: 'mission-os-test',
      service: 'gmail',
      resourceRef: 'mailbox:1',
      tier: 'personal',
      tenantSlug: 'tenant-a',
      purpose: 'draft reply',
      summary: 'one message',
    });
    expect(plane.projectTaint('mission-os-test').highestTier).toBe('personal');
    expect(() => plane.assertEgressAllowed('mission-os-test', 'external')).toThrow('Egress denied');
    expect(() => plane.assertEgressAllowed('mission-os-test', 'public')).toThrow('Egress denied');
  });

  it('OS-06 drains only double-gated auto-approve actions in submission order', async () => {
    const plane = createPlane();
    plane.registerAutoApproveRule({
      op: 'test:write',
      actionTag: 'safe',
      enabledBy: 'human:famao',
    });
    const calls: string[] = [];
    plane.submitHeldAction(
      action({
        actionTag: 'safe',
        autoApprovable: true,
        apply: () => {
          calls.push('one');
          return 'one';
        },
      })
    );
    plane.submitHeldAction(
      action({
        actionTag: 'unsafe',
        autoApprovable: true,
        apply: () => {
          calls.push('two');
          return 'two';
        },
      })
    );
    await plane.drainHeldActions('mission-os-test');
    expect(calls).toEqual(['one']);
  });

  it('OS-07 reverts an applied action and OS-08 fences host/network access', async () => {
    const plane = createPlane();
    let reverted = false;
    const record = plane.submitHeldAction(
      action({
        previousState: 'before',
        revert: (_result: string, previous: string) => {
          reverted = previous === 'before';
          return undefined;
        },
      })
    );
    plane.decideHeldAction(record.id, 'approved', approval(record));
    await plane.applyHeldAction(record.id);
    await plane.revertHeldAction(record.id);
    expect(reverted).toBe(true);
    expect(plane.runGovernedCode('process.env.SECRET', {})).toBeUndefined();
    expect(plane.runGovernedCode('typeof fetch', {})).toBe('undefined');
    expect(() =>
      plane.runGovernedCode(
        'globalThis.constructor.constructor("return globalThis")()["process"].getBuiltinModule("node:fs").readFileSync("package.json")',
        {}
      )
    ).toThrow();
    expect(plane.runGovernedCode<number>('1 + 2', {})).toBe(3);
  });

  it('OS-09 bounds catalog text, OS-10 isolates threads, and OS-11 validates bindings', () => {
    const plane = createPlane();
    expect(
      plane.buildKnowledgeCatalog([{ id: '1', title: 'T', description: 'D'.repeat(400) }])[0]
        .description.length
    ).toBeLessThan(280);
    plane.bindThreadCapability('thread-a', 'reply:slack:T1');
    expect(() => plane.assertThreadCapability('thread-b', 'reply:slack:T1')).toThrow('not bound');
    plane.registerBlueprint({
      id: 'weekly',
      required_bindings: [{ name: 'mail', service: 'gmail' }],
    });
    expect(() =>
      plane.generateGadget({
        id: 'g1',
        blueprintId: 'weekly',
        bindings: {},
        capabilitySubject: 'gadget:g1',
        tenantSlug: 'tenant-a',
        operations: [gadgetReadOperation],
      })
    ).toThrow('Missing');
    expect(
      plane.generateGadget({
        id: 'g1',
        blueprintId: 'weekly',
        bindings: { mail: {} },
        capabilitySubject: 'gadget:g1',
        tenantSlug: 'tenant-a',
        operations: [gadgetReadOperation],
      }).sideEffectsHeld
    ).toBe(true);
  });

  it('OS-12 proves a hermetic run has no allowed network egress', () => {
    const plane = createPlane();
    plane.recordNetworkAttempt({
      destination: 'smtp.example',
      allowed: false,
      reason: 'interceptor',
    });
    expect(() => plane.assertNoUnexpectedNetworkEgress()).not.toThrow();
    plane.recordNetworkAttempt({ destination: 'unexpected.example', allowed: true });
    expect(() => plane.assertNoUnexpectedNetworkEgress()).toThrow('Unexpected network egress');
  });

  it('OS-13 revokes capabilities without deleting graph history', () => {
    const plane = createPlane();
    const edge = plane.grantCapability('gadget:g1', 'slack:team:T1', 'write');
    expect(() => plane.assertCapability('gadget:g1', 'slack:team:T1', 'write')).not.toThrow();
    plane.revokeCapability(edge.id, 'human:famao');
    expect(() => plane.assertCapability('gadget:g1', 'slack:team:T1', 'write')).toThrow('denied');
  });

  it('OS-14 discovers typed gadget operations and holds side effects', async () => {
    const plane = createPlane();
    plane.registerBlueprint({
      id: 'weekly',
      required_bindings: [{ name: 'mail', service: 'gmail' }],
    });
    const manifest = plane.generateGadget({
      id: 'g1',
      blueprintId: 'weekly',
      bindings: { mail: {} },
      capabilitySubject: 'gadget:g1',
      tenantSlug: 'tenant-a',
      operations: [
        gadgetReadOperation,
        {
          name: 'send_message',
          description: 'Queue a message for human approval.',
          inputSchema: z.object({ message: z.string().min(1) }),
          outputSchema: z.object({ accepted: z.string() }),
          effect: 'held' as const,
          capabilityResource: 'slack:team:T1',
          governedCode: '({ accepted: bindings.input.message })',
          introduction: { service: 'slack', resourceRef: 'team:T1' },
          observation: {
            tier: 'confidential' as const,
            purpose: 'Queue an approved message.',
            summary: 'Gadget message queued.',
          },
        },
      ],
    });
    await grantIntroduction(plane, {
      missionId: 'mission-os-test',
      service: 'knowledge',
      resourceRef: 'gadget',
      scope: 'read',
    });
    await grantIntroduction(plane, {
      missionId: 'mission-os-test',
      service: 'slack',
      resourceRef: 'team:T1',
      scope: 'write',
    });
    plane.grantCapability('gadget:g1', 'knowledge:gadget', 'read');
    const writeEdge = plane.grantCapability('gadget:g1', 'slack:team:T1', 'write');
    expect(manifest.operations.map((operation) => operation.name)).toEqual([
      'read_summary',
      'send_message',
    ]);
    expect(
      plane.discoverGadgetOperations('g1', {
        missionId: 'mission-os-test',
        principal: 'agent:gadget-test',
        tenantSlug: 'tenant-a',
      })[1]
    ).toMatchObject({
      name: 'send_message',
      effect: 'held',
      inputSchema: { type: 'object' },
    });
    await expect(
      plane.invokeGadgetOperation(
        'g1',
        'read_summary',
        { query: 'today' },
        {
          missionId: 'mission-os-test',
          submittedBy: 'operator',
          tenantSlug: 'tenant-a',
        }
      )
    ).resolves.toEqual({ effect: 'read', value: { summary: 'today' } });
    await expect(
      plane.invokeGadgetOperation(
        'g1',
        'read_summary',
        { query: 42 },
        {
          missionId: 'mission-os-test',
          submittedBy: 'operator',
          tenantSlug: 'tenant-a',
        }
      )
    ).rejects.toThrow('Invalid input');
    const invocation = await plane.invokeGadgetOperation(
      'g1',
      'send_message',
      { message: 'hello' },
      { missionId: 'mission-os-test', submittedBy: 'operator', tenantSlug: 'tenant-a' }
    );
    expect(invocation.effect).toBe('held');
    if (invocation.effect !== 'held') throw new Error('Expected held gadget operation');
    const held = plane.getHeldAction(invocation.heldActionId);
    expect(held?.op).toBe('gadget:g1:send_message');
    plane.decideHeldAction(invocation.heldActionId, 'approved', approval(held!));
    const applied = await plane.applyHeldAction(invocation.heldActionId);
    expect(applied.status).toBe('applied');
    expect(applied.result).toEqual({ accepted: 'hello' });
    expect(plane.listObservations('mission-os-test')).toContainEqual(
      expect.objectContaining({
        service: 'knowledge',
        resourceRef: 'gadget',
        tenantSlug: 'tenant-a',
        observedBy: 'operator',
      })
    );

    const blockedInvocation = await plane.invokeGadgetOperation(
      'g1',
      'send_message',
      { message: 'revoked' },
      { missionId: 'mission-os-test', submittedBy: 'operator', tenantSlug: 'tenant-a' }
    );
    if (blockedInvocation.effect !== 'held') throw new Error('Expected held gadget operation');
    plane.revokeCapability(writeEdge.id, 'human:famao');
    const blockedHeld = plane.getHeldAction(blockedInvocation.heldActionId);
    plane.decideHeldAction(blockedInvocation.heldActionId, 'approved', approval(blockedHeld!));
    expect((await plane.applyHeldAction(blockedInvocation.heldActionId)).status).toBe('failed');
  });

  it('OS-15 protects auth config/state', () => {
    expect(() =>
      assertImmutableAuthConfig({ redirectUri: 'changed' }, { redirectUri: 'original' }, [
        'redirectUri',
      ])
    ).toThrow('immutable');
    expect(isConstantTimeEqual('oauth-state', 'oauth-state')).toBe(true);
    expect(isConstantTimeEqual('oauth-state', 'other-state')).toBe(false);
    expect(AUTH_CONFIG_BOUNDARY_INVENTORY.every((entry) => entry.allowedSources.length > 0)).toBe(
      true
    );
    expect(() => assertAuthConfigMutationSource('viewer_scope_mode', 'http-request')).toThrow(
      'cannot be changed'
    );
    expect(() => assertAuthConfigMutationSource('oauth_profile', 'surface-state')).toThrow(
      'cannot be changed'
    );
    expect(() => assertAuthConfigMutationSource('tenant_registry', 'human-approved-file')).toThrow(
      'human approver'
    );
    expect(() =>
      assertAuthConfigMutationSource('tenant_registry', 'human-approved-file', 'human:famao')
    ).not.toThrow();
  });

  it('rejects unauthenticated approval and applies concurrent requests once', async () => {
    const plane = createPlane();
    let applications = 0;
    const record = plane.submitHeldAction(
      action({
        apply: async () => {
          applications += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'done';
        },
      })
    );
    expect(() =>
      plane.decideHeldAction(record.id, 'approved', {
        ...approval(record),
        decidedByType: 'service',
        authenticated: false,
      })
    ).toThrow('authenticated human');
    plane.decideHeldAction(record.id, 'approved', approval(record));
    await Promise.all([plane.applyHeldAction(record.id), plane.applyHeldAction(record.id)]);
    expect(applications).toBe(1);
  });

  it('cancels descendants and rejects tainted egress without a tenant target', () => {
    const plane = createPlane();
    const parent = plane.submitHeldAction(
      action({
        simulatable: true,
        simulate: () => ({ provisionalRefs: ['~parent'], value: '~parent', simulated: true }),
      })
    );
    const child = plane.submitHeldAction(
      action({ dependsOn: [parent.id], params: { input: '~parent' } })
    );
    plane.decideHeldAction(parent.id, 'rejected', approval(parent));
    expect(plane.getHeldAction(child.id)?.status).toBe('cancelled');
    plane.recordObservation({
      missionId: 'mission-os-test',
      service: 'gmail',
      resourceRef: 'mailbox:1',
      tier: 'confidential',
      tenantSlug: 'tenant-a',
      purpose: 'test',
      summary: 'test',
    });
    expect(() => plane.assertEgressAllowed('mission-os-test', 'confidential')).toThrow(
      'Egress denied'
    );
  });

  it('requires active capability parents and guards actual fetch attempts', async () => {
    const plane = createPlane();
    const parent = plane.grantCapability('gadget:g1', 'network:egress', 'write');
    plane.grantCapability('gadget:g1', 'slack:team:T1', 'write', {
      parentId: parent.id,
    });
    plane.revokeCapability(parent.id, 'human:famao');
    expect(() => plane.assertCapability('gadget:g1', 'slack:team:T1', 'write')).toThrow('denied');
    await expect(
      plane.withNetworkEgressGuard(() => fetch('https://blocked.example.test'))
    ).rejects.toThrow('Network egress denied');
  });

  it('persists durable control-plane state and restores it fail-closed', async () => {
    const statePath = pathResolver.sharedTmp('cloudflare-os-state-test.json');
    try {
      safeUnlinkSync(statePath);
      const first = new CloudflareOsControlPlane({ statePath });
      const secret = 'super-secret-payload';
      const record = first.submitHeldAction(
        action({ id: 'durable-test-action', params: { token: secret } })
      );
      first.decideHeldAction(record.id, 'approved', approval(record));
      expect(String(safeReadFile(statePath, { encoding: 'utf8' }))).not.toContain(secret);
      const restored = new CloudflareOsControlPlane({ statePath });
      expect(restored.getHeldAction(record.id)?.status).toBe('approved');
      const result = await restored.applyHeldAction(record.id);
      expect(result.status).toBe('failed');
      expect(result.applyError).toContain('must be registered');
    } finally {
      safeUnlinkSync(statePath);
    }
  });

  it('rejects a persisted state path outside the repository root', () => {
    expect(
      () => new CloudflareOsControlPlane({ statePath: '../outside-control-plane.json' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('persists and restores gadget contracts with tenant and observation boundaries', async () => {
    const statePath = pathResolver.sharedTmp('cloudflare-os-gadget-state-test.json');
    try {
      safeUnlinkSync(statePath);
      const first = new CloudflareOsControlPlane({ statePath });
      first.registerBlueprint({
        id: 'weekly-persist',
        required_bindings: [{ name: 'mail', service: 'gmail' }],
      });
      first.generateGadget({
        id: 'persisted-gadget',
        blueprintId: 'weekly-persist',
        bindings: { mail: {} },
        capabilitySubject: 'gadget:persisted',
        tenantSlug: 'tenant-a',
        operations: [gadgetReadOperation],
      });
      await grantIntroduction(first, {
        missionId: 'mission-gadget-persist',
        service: 'knowledge',
        resourceRef: 'gadget',
        scope: 'read',
      });
      first.grantCapability('gadget:persisted', 'knowledge:gadget', 'read');

      const restored = new CloudflareOsControlPlane({ statePath });
      expect(
        restored.discoverGadgetOperations('persisted-gadget', {
          missionId: 'mission-gadget-persist',
          principal: 'agent:gadget-test',
          tenantSlug: 'tenant-a',
        })
      ).toHaveLength(1);
      await expect(
        restored.invokeGadgetOperation(
          'persisted-gadget',
          'read_summary',
          { query: 'wrong tenant' },
          { missionId: 'mission-gadget-persist', submittedBy: 'operator', tenantSlug: 'tenant-b' }
        )
      ).rejects.toThrow('tenant scope mismatch');
      await expect(
        restored.invokeGadgetOperation(
          'persisted-gadget',
          'read_summary',
          { query: 'restored' },
          { missionId: 'mission-gadget-persist', submittedBy: 'operator', tenantSlug: 'tenant-a' }
        )
      ).resolves.toEqual({ effect: 'read', value: { summary: 'restored' } });
    } finally {
      safeUnlinkSync(statePath);
    }
  });

  it('refreshes observations before projecting taint for another process', () => {
    const statePath = pathResolver.sharedTmp('cloudflare-os-observation-refresh-test.json');
    try {
      safeUnlinkSync(statePath);
      const writer = new CloudflareOsControlPlane({ statePath });
      const reader = new CloudflareOsControlPlane({ statePath });

      writer.recordObservation({
        missionId: 'mission-refresh',
        service: 'gmail',
        resourceRef: 'mailbox:inbox',
        tier: 'personal',
        tenantSlug: 'tenant-a',
        purpose: 'refresh test',
        summary: 'personal observation',
      });

      expect(reader.projectTaint('mission-refresh')).toMatchObject({
        highestTier: 'personal',
        tenants: ['tenant-a'],
        prohibitExternal: true,
      });
    } finally {
      safeUnlinkSync(statePath);
    }
  });
});
