/**
 * End to end for everyday business decisions: owner form → signed statement →
 * charter → call-site adapter → approval gate. Only approval-request
 * persistence, the audit chain and notifications are stubbed; the
 * decision-rights matrix is mocked per case so each escalation kind is explicit.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./approval-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./approval-store.js')>()),
  createApprovalRequest: vi.fn(() => ({ id: 'req-1', status: 'pending' })),
  listApprovalRequests: vi.fn(() => []),
  lookupSessionApprovalCache: vi.fn(() => null),
  recordSessionCacheAutoApproval: vi.fn(),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance-action-recorder.js', () => ({ recordGovernanceAction: vi.fn() }));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: vi.fn(() => null),
  evaluateDecisionRights: vi.fn(() => null),
}));
import { evaluateDecisionRights } from '../decision-rights.js';

import * as pathResolver from '../path-resolver.js';
import { humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import { enforceApprovalGate } from './approval-gate.js';
import { readCharterLedger, findActiveCharter } from './accountability-charter-registry.js';
import { charterInputForDecision } from './charter-call-site.js';
import {
  acceptCharterFromForm,
  parseCharterForm,
  renderAcceptanceStatement,
  statementDigest,
  viewCharter,
} from './charter-service.js';

const TENANT = 'biz-co';
const NO_DELEGATION_TENANT = 'biz-plain';

function matrix(kind: 'human_acceptance' | 'over_threshold' | null, charterDelegable: boolean) {
  vi.mocked(evaluateDecisionRights).mockReturnValue(
    kind
      ? ({ requiresEscalation: true, escalationKind: kind, charterDelegable } as never)
      : (null as never)
  );
}

describe('accountability charter — everyday business decisions', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });

  const decide = (
    decisionType: string,
    correlationId: string,
    extra: { amount?: number; recipients?: number; tenantSlug?: string } = {}
  ) => {
    const tenantSlug = extra.tenantSlug ?? TENANT;
    const charter = charterInputForDecision(
      {
        tenantSlug,
        agentId: 'secretary',
        decisionType,
        amount: extra.amount,
        recipients: extra.recipients,
      },
      opts()
    );
    expect(charter).toBeDefined();
    return enforceApprovalGate({
      operationId: `business.${decisionType}`,
      agentId: 'secretary',
      correlationId,
      channel: 'mission',
      payload: {
        decision_type: decisionType,
        tenant_slug: tenantSlug,
        ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
      },
      hasHuman: false,
      charter: charter!,
    });
  };

  const acceptFromForm = (tenant: string, delegated: string[]) => {
    const parsed = parseCharterForm({
      tenant_slug: tenant,
      per_action: 0,
      per_day: 0,
      per_month: 3_000_000,
      max_loss_per_incident: 1_000_000,
      allow_named_spend: false,
      allow_customer_outbound: false,
      delegated_decisions: delegated,
      supersedes_decision_rights: false,
      deputies: [],
      expires_in_days: 30,
      reputational_class_max: 'B',
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const now = new Date(Date.now() - 1000);
    const statement = renderAcceptanceStatement({
      form: parsed.form,
      accountableId: 'user:owner',
      displayName: 'Owner',
      now,
    });
    return acceptCharterFromForm(
      {
        form: parsed.form,
        acceptedBy: humanActor('owner'),
        displayName: 'Owner',
        holderRole: 'owner',
        statementSha256: statementDigest(statement),
        now,
        idNonce: 'test',
      },
      opts()
    );
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-biz-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    acceptFromForm(TENANT, [
      'meeting_scheduling',
      'internal_task_assignment',
      'headcount_expansion',
    ]);
    acceptFromForm(NO_DELEGATION_TENANT, []);
  });
  afterAll(() => {
    vi.mocked(evaluateDecisionRights).mockReturnValue(null as never);
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => matrix(null, false));

  it('the signed statement names each delegated decision, and the read model lists them', () => {
    const charter = findActiveCharter(
      { kind: 'organization', tenant_slug: TENANT },
      new Date(),
      opts()
    )!;
    expect(charter.envelope.delegated_decisions).toEqual({
      headcount_expansion: 'allow',
      internal_task_assignment: 'allow',
      meeting_scheduling: 'allow',
    });
    // Hiring is irreversible: named; scheduling is reversible: not named.
    expect(charter.envelope.irreversible_named_actions).toEqual(['headcount_expansion']);
    expect(viewCharter(charter, new Date(), opts()).delegated_decisions).toEqual([
      'headcount_expansion',
      'internal_task_assignment',
      'meeting_scheduling',
    ]);
  });

  it('a delegated decision the organization made charter-delegable runs unattended', () => {
    matrix('human_acceptance', true);
    expect(decide('meeting_scheduling', 'm-1')).toMatchObject({
      allowed: true,
      status: 'not_required',
    });
    expect(decide('internal_task_assignment', 'm-2').allowed).toBe(true);
  });

  it('a decision the owner did not delegate goes to a human, and the ask is recorded as an amendment', () => {
    matrix('human_acceptance', true);
    const r = decide('external_reply', 'm-3');
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('[HUMAN_REQUIRED]');
    const charter = findActiveCharter(
      { kind: 'organization', tenant_slug: TENANT },
      new Date(),
      opts()
    )!;
    expect(
      readCharterLedger(charter, opts()).some(
        (e) =>
          e.kind === 'denied' && e.amendment_field === 'envelope.delegated_decisions.external_reply'
      )
    ).toBe(true);
  });

  it('a delegated decision still stays inside the appetite (blast radius)', () => {
    matrix('human_acceptance', true);
    expect(decide('meeting_scheduling', 'm-4', { recipients: 3 }).allowed).toBe(false);
  });

  it('the matrix wins when the organization did not mark the type delegable, or the value is over its threshold', () => {
    matrix('human_acceptance', false);
    expect(decide('meeting_scheduling', 'm-5').allowed).toBe(false);
    matrix('over_threshold', true);
    expect(decide('meeting_scheduling', 'm-6').allowed).toBe(false);
  });

  it('hiring: within the declared loss it runs; above it a human decides — and no budget is spent', () => {
    expect(decide('headcount_expansion', 'm-7', { amount: 800_000 }).allowed).toBe(true);
    expect(decide('headcount_expansion', 'm-8', { amount: 1_500_000 }).allowed).toBe(false);
  });

  it('a charter that delegates nothing keeps every business decision with a human', () => {
    matrix('human_acceptance', true);
    for (const type of ['meeting_scheduling', 'internal_task_assignment']) {
      expect(decide(type, `p-${type}`, { tenantSlug: NO_DELEGATION_TENANT }).allowed).toBe(false);
    }
  });

  it('the form refuses a decision type that is not delegable', () => {
    for (const bad of ['operational_spend', 'secret_mutation', 42]) {
      const parsed = parseCharterForm({
        tenant_slug: TENANT,
        per_action: 0,
        per_day: 0,
        per_month: 0,
        max_loss_per_incident: 0,
        delegated_decisions: [bad],
        deputies: [],
        expires_in_days: 30,
      });
      expect(parsed.ok).toBe(false);
    }
  });
});
