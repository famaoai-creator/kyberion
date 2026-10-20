import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanActor } from '@agent/core/actor';
import * as pathResolver from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import {
  acceptCharter,
  readCharterLedger,
} from '@agent/core/governance/accountability-charter-registry';
import {
  withDelegatedExecutionFrame,
  withDelegatedExecutionOptions,
  type DelegatedExecutionPolicy,
} from '@agent/core/governance/delegated-execution';
import { mintScopeEnvelope, withScopeEnvelope } from '@agent/core/scope-envelope';
import { runSteps } from './run_pipeline.js';

vi.mock('@agent/core/governance/approval-policy', () => ({
  resolveApprovalPolicy: () => ({ requiresApproval: false, missingRequirements: [] }),
}));
vi.mock('@agent/core/decision-rights', () => ({
  resolveDecisionRightsMatrix: () => ({}),
  evaluateDecisionRights: () => null,
}));

describe('real pipeline delegated execution and control composition', () => {
  let root: string;
  let charter: ReturnType<typeof acceptCharter>;
  let saved: Record<string, string | undefined>;
  const scope = { kind: 'organization', tenant_slug: 'pipeline-delegation' } as const;
  const policy: DelegatedExecutionPolicy = {
    version: '1',
    operations: [
      {
        operation_id: 'system:log',
        decision_type: 'internal_task_assignment',
        required_paths: [['message']],
        risk_level: 'low',
        max_ttl_seconds: 600,
      },
    ],
  };
  beforeEach(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active/shared/tmp',
      `pipeline-delegation-${randomUUID()}`
    );
    saved = Object.fromEntries(
      ['KYBERION_PERSONA', 'MISSION_ROLE', 'MISSION_ID', 'KYBERION_TASK_ID', 'KYBERION_TENANT'].map(
        (key) => [key, process.env[key]]
      )
    );
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.MISSION_ID;
    delete process.env.KYBERION_TASK_ID;
    delete process.env.KYBERION_TENANT;
    charter = acceptCharter(
      {
        draft: {
          charter_id: 'chr-pipeline-permit',
          scope,
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry' },
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {},
            delegated_decisions: { internal_task_assignment: 'allow' },
            irreversible: 'forbid',
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'D',
            blast_radius_max: { recipients: 5, systems: 5 },
            tripwires: [],
          },
        },
        statement: 'I accept.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
      },
      { rootDir: root }
    );
  });
  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const execute = (steps: Parameters<typeof runSteps>[0]) => {
    const envelope = mintScopeEnvelope({
      identity: {
        tenant_slug: scope.tenant_slug,
        session_id: 'session-test',
        tier: 'confidential',
      },
      policy: {
        read_tiers: ['confidential'],
        write_tier: 'confidential',
        purpose: 'test internal work',
      },
    });
    return withScopeEnvelope(envelope, () =>
      withDelegatedExecutionOptions(
        {
          rootDir: root,
          policy,
          workItem: {
            id: 'work-item-standalone',
            tenantSlug: scope.tenant_slug,
            agentId: 'dot-worker',
          },
        },
        () =>
          withDelegatedExecutionFrame('pipelines/test-delegation.json', () =>
            runSteps(
              steps,
              {},
              {
                delegatedExecution: 'require',
                hasHuman: false,
                runId: 'pipeline-test-run',
                trustResolved: true,
              }
            )
          )
      )
    );
  };

  it('executes two same-operation steps with generated independent stable identities', async () => {
    const result = await execute([
      { op: 'system:log', params: { message: 'First internal assignment' } },
      { op: 'system:log', params: { message: 'Second internal assignment' } },
    ]);
    expect(result.results.every((entry) => entry.status === 'success')).toBe(true);
    const completed = readCharterLedger(charter, { rootDir: root }).filter(
      (e) => e.kind === 'delegated_execution' && e.state === 'succeeded'
    );
    expect(completed).toHaveLength(2);
    expect(
      new Set(completed.map((entry) => entry.kind === 'delegated_execution' && entry.permit_id))
        .size
    ).toBe(2);
  });

  it('keeps foreach iterations independently bound and permits internal wait composition', async () => {
    const result = await execute([
      {
        id: 'batch',
        op: 'core:foreach',
        params: {
          items: ['one', 'two'],
          as: 'item',
          do: [
            { op: 'system:log', params: { message: '{{item}}' } },
            { op: 'core:wait', params: { ms: 0 } },
          ],
        },
      },
    ]);
    expect(result.results.every((entry) => entry.status === 'success')).toBe(true);
    const completed = readCharterLedger(charter, { rootDir: root }).filter(
      (e) => e.kind === 'delegated_execution' && e.state === 'succeeded'
    );
    expect(completed).toHaveLength(2);
    expect(
      new Set(completed.map((entry) => entry.kind === 'delegated_execution' && entry.step_id)).size
    ).toBe(2);
  });
});
