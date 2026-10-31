/** Offline fixture human ingress only; this is not production human authentication. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  canonicalJson,
  type DecisionRecord,
  type DecisionDecidedBy,
} from '../decision-ledger/model.js';
import type { SemanticVerdict } from './judgment-contract.js';
import type { SyntheticJudgmentQuestionDraft } from './judgment-routing.js';

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp/human-handoff-' + randomUUID());
const now = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let ledger: typeof import('../decision-ledger/ledger.js');
let promotion: typeof import('../decision-ledger/promote.js');
let latency: typeof import('./judgment-latency-fixture.js');
let precedents: typeof import('./judgment-precedents.js');
let validation: typeof import('./judgment-validation.js');
let semantic: typeof import('./semantic-judgment.js');
let evidence: typeof import('./judgment-evidence.js');
let routing: typeof import('./judgment-routing.js');
let approvals: typeof import('../governance/approval-store.js');
let sequence = 0;
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'synthetic-latency',
  organization_id: 'synthetic-org',
  project_id: 'synthetic-project',
};
const config = { provider: 'fixture-provider', model: 'fixture-model', maxOutputTokens: 500 };
const owner = <T>(fn: () => T) =>
  authority.withExecutionContext(
    'ecosystem_architect',
    fn,
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
const ownerAsync = <T>(fn: () => Promise<T>) =>
  authority.withExecutionContextAsync(
    'ecosystem_architect',
    fn,
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
const hash = (value: unknown) => precedents.judgmentCanonicalHash(value);
const valueSchema = z
  .object({
    target_users: z.literal(100),
    max_p95_ms: z.literal(500),
    max_incremental_monthly_cost: z.number().int().min(0).max(1000),
    currency: z.literal('JPY'),
  })
  .strict();

beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  const copy = (relative: string): void => {
    const source = path.join(sourceRoot, relative),
      target = path.join(root, relative);
    if (bootstrap.safeLstat(source).isDirectory()) {
      bootstrap.safeMkdir(target, { recursive: true });
      for (const name of bootstrap.safeReaddir(source)) copy(path.join(relative, name));
    } else bootstrap.safeCopyFileSync(source, target);
  };
  for (const name of ['schemas', 'governance', 'orchestration']) copy('knowledge/product/' + name);
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrap.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/synthetic-latency.json'),
    JSON.stringify({
      tenant_slug: 'synthetic-latency',
      display_name: 'Synthetic human fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeMkdir(path.join(root, 'knowledge/confidential/synthetic-latency/decisions'), {
    recursive: true,
  });
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', scope.tenant_slug);
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  ledger = await import('../decision-ledger/ledger.js');
  promotion = await import('../decision-ledger/promote.js');
  latency = await import('./judgment-latency-fixture.js');
  precedents = await import('./judgment-precedents.js');
  validation = await import('./judgment-validation.js');
  semantic = await import('./semantic-judgment.js');
  evidence = await import('./judgment-evidence.js');
  routing = await import('./judgment-routing.js');
  approvals = await import('../governance/approval-store.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  owner(() =>
    saveProjectRecord({
      project_id: scope.project_id,
      name: 'Fixture',
      summary: 'Offline human roundtrip',
      status: 'active',
      tier: 'confidential',
      tenant_slug: scope.tenant_slug,
      organization_id: scope.organization_id,
    })
  );
}, 60000);
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrap.safeRmSync(root, { recursive: true, force: true });
});

function fixture() {
  const id = ++sequence;
  const location = { tenantSlug: scope.tenant_slug, caseId: 'human-handoff-' + id };
  const workRef = 'human-work-' + id;
  let revision = '1';
  let currentInputHash: string | undefined;
  const initial = latency.createJudgmentLatencyFixture();
  const { id: _id, status: _status, case_id: _case, ...seed } = initial.decision;
  void _id;
  void _status;
  void _case;
  owner(() => ledger.appendDecisions(location, [seed]));
  const active = () =>
    owner(() =>
      ledger
        .readLedger(location)
        .find((record) => record.status === 'active' && record.key === 'performance.goal')!
    );
  const snapshot = () =>
    owner(() => {
      const result = precedents.createJudgmentPrecedentSnapshot(
        { scope, selected_case_ids: [location.caseId], allowed_case_ids: [location.caseId] },
        {
          resolveCaseBinding: () => ({ case_id: location.caseId, scope }),
          readLedger: () => ledger.readLedger(location),
          resolveGoals: (source) => {
            // The semantic model cannot supply the mapping: re-read the actual selected ledger row.
            const record = ledger
              .readLedger(location)
              .find((row) => row.id === source.decision_id)!;
            if (hash(record) !== source.decision_version_hash)
              throw new Error('Trusted goal source changed during reconstruction');
            const value = valueSchema.parse(record.value);
            return [
              {
                case_id: source.case_id,
                decision_id: source.decision_id,
                decision_version_hash: source.decision_version_hash,
                constraints: {
                  kind: 'latency_goal_v1',
                  goal_key: 'latency',
                  service_key: initial.goal.service_key,
                  load_profile_hash: initial.goal.load_profile_hash,
                  ...value,
                  permitted_change: 'isolated_fixture_only',
                },
              },
            ];
          },
        }
      );
      if (result.status !== 'ready') throw new Error(result.detail);
      return result.snapshot;
    });
  const ledgerBytes = () =>
    owner(() =>
      io.safeReadFile(path.join(ledger.ledgerDir(location), 'decisions.jsonl'), {
        encoding: 'utf8',
      })
    );
  const revise = (budget: number, decidedBy: DecisionDecidedBy, basisRef: string) =>
    owner(() =>
      ledger.withDecisionLedgerLock(location, () => {
        const current = active();
        const candidate: DecisionRecord = {
          ...current,
          id: 'D-0000',
          state: 'proposed',
          value: { ...valueSchema.parse(current.value), max_incremental_monthly_cost: budget },
          // T02 hashes this unordered set canonically; keep the trusted fixture's
          // persisted source in that same order before exact version comparison.
          basis: [...current.basis, { ref: basisRef, version: revision }].sort((left, right) => {
            const a = canonicalJson(left),
              b = canonicalJson(right);
            return a < b ? -1 : a > b ? 1 : 0;
          }),
          supersedes: current.id,
          origin: 'hearing',
        };
        const promoted = promotion.promoteDecision({
          decision: candidate,
          decidedBy,
          now: new Date(now).toISOString(),
        });
        if (promoted.outcome !== 'decided')
          return { status: 'refused' as const, reason: promoted.reason };
        const { id: _drop, status: _old, case_id: _scope, ...incoming } = promoted.decision;
        void _drop;
        void _old;
        void _scope;
        // The append facade takes its own re-entrant ledger lock; no direct ledger file write.
        const saved = ledger.appendDecisions(location, [incoming]);
        return { status: 'recorded' as const, record: saved.appended[0] };
      })
    );
  type Principal = {
    id: string;
    role: 'owner' | 'viewer';
    tenant: string;
    organization?: string;
    project?: string;
    caseId?: string;
  };
  type Question = {
    ref: string;
    revision: string;
    requestHash: string;
    scopeHash: string;
    targetHash: string;
    draft: SyntheticJudgmentQuestionDraft;
    resolved?: DecisionRecord;
  };
  const sessions = new WeakMap<object, Principal>();
  const questions = new Map<string, Question>();
  // Only the test controller owns issuance. No production auth or model-facing mint exists.
  const human = (principal: Principal) => {
    const token = Object.freeze({});
    sessions.set(token, {
      organization: scope.organization_id,
      project: scope.project_id,
      caseId: location.caseId,
      ...principal,
    });
    return token;
  };
  const recordDraft = (draft: SyntheticJudgmentQuestionDraft, requestHash: string) => {
    const key =
      'question-' +
      hash({
        work_ref: workRef,
        revision,
        requestHash,
        scopeHash: hash(scope),
        caseId: location.caseId,
        targetHash: hash(active()),
      });
    if (!questions.has(key))
      questions.set(key, {
        ref: key,
        revision,
        requestHash,
        scopeHash: hash(scope),
        targetHash: hash(active()),
        draft: structuredClone(draft),
      });
    return key;
  };
  const answerSchema = z
    .object({ question_ref: z.string().min(1), budget: z.literal(1000) })
    .strict();
  const reply = (token: unknown, payload: unknown) => {
    if (payload === undefined) return { status: 'pending' as const };
    const principal = token && typeof token === 'object' ? sessions.get(token) : undefined;
    if (
      !principal ||
      principal.tenant !== scope.tenant_slug ||
      principal.organization !== scope.organization_id ||
      principal.project !== scope.project_id ||
      principal.caseId !== location.caseId ||
      principal.role !== 'owner'
    )
      return { status: 'refused' as const };
    const parsed = answerSchema.safeParse(payload);
    if (!parsed.success) return { status: 'refused' as const };
    const question = questions.get(parsed.data.question_ref);
    if (
      !question ||
      question.revision !== revision ||
      question.requestHash !== currentInputHash ||
      question.scopeHash !== hash(scope)
    )
      return { status: 'refused' as const };
    if (question.resolved) return { status: 'recorded' as const, record: question.resolved };
    return owner(() =>
      ledger.withDecisionLedgerLock(location, () => {
        if (question.targetHash !== hash(active())) return { status: 'refused' as const };
        const saved = revise(
          parsed.data.budget,
          { kind: 'human', id: principal.id, role: principal.role },
          question.ref
        );
        if (saved.status === 'recorded') question.resolved = saved.record;
        return saved;
      })
    );
  };
  const evaluate = async (
    operation: 'add_cost' | 'limit_users' | 'accept_latency',
    disposition: 'escalate' | 'reframe' | 'apply_precedent'
  ) =>
    ownerAsync(async () => {
      const snap = snapshot();
      const candidate = latency.resolveSyntheticLatencyProposal(operation);
      if (candidate.status !== 'ready') throw new Error(candidate.detail);
      const modelInput = validation.buildJudgmentModelInput(snap, candidate.facts, [
        {
          evidence_key: 'synthetic-observation',
          text: 'Fixed synthetic measurement: 65 users, p95 1800ms',
        },
      ]);
      const binding = {
        schema_version: '1' as const,
        work_ref: workRef,
        work_revision: revision,
        trigger_key: 'human-handoff',
        scope_hash: snap.scope_hash,
        ...validation.judgmentModelInputHashes(modelInput),
        precedent_snapshot_hash: snap.snapshot_hash,
        policy_version: 'fixture-effect-policy',
        rubric_version: 'fixture-rubric',
        evaluator_version: 'fixture-evaluator',
        model_config_hash: semantic.semanticJudgmentModelConfigHash(config),
      };
      const context = {
        binding,
        scope,
        modelInput,
        snapshot: snap,
        requiredGoalKeys: ['latency'],
        knownProposalKeys: ['add_cost', 'limit_users', 'accept_latency'],
      };
      currentInputHash = binding.request_hash;
      const current = () => ({
        expectedBinding: binding,
        currentSnapshot: { status: 'ready' as const, snapshot: snapshot() },
      });
      const deps = { now: () => now, readCurrentContext: current };
      const verdict: SemanticVerdict =
        disposition === 'escalate'
          ? {
              disposition,
              rationale: 'New cost needs a value choice',
              question: 'Consider 1000 JPY monthly while keeping 100 users and p95 at most 500ms?',
              options: [
                { label: 'Keep zero cost', consequences: 'Continue local investigation' },
                {
                  label: 'Allow 1000 JPY',
                  consequences: 'Separate effect approval is still required',
                },
              ],
              missing_facts: [],
            }
          : disposition === 'reframe'
            ? {
                disposition,
                rationale: 'The false binary weakens the original target',
                violated_goal_keys: ['latency'],
                revised_question:
                  'Investigate the cause while preserving 100 users, p95 <=500ms and zero cost.',
                evidence_needed: ['Fixed synthetic configuration'],
              }
            : {
                disposition,
                rationale: 'The explicit current human decision covers this candidate',
                precedent_keys: snap.evidence_refs.map((ref) => ref.source_key),
                applicability: ['Isolated synthetic fixture only'],
              };
      const result = await semantic.assessSemanticJudgment(
        {
          ...context,
          mode: 'offline_fixture',
          parentDeadlineMs: now + 15000,
          parentTokenAllowance: 1000,
          maxOutputTokens: 500,
        },
        {
          now: () => now,
          schedule: () => () => undefined,
          readCurrentContext: current,
          port: {
            mode: 'offline_fixture',
            provider: config.provider,
            model: config.model,
            invoke: async () => ({
              text: JSON.stringify(verdict),
              usage: { input_tokens: 40, output_tokens: 30 },
            }),
          },
        }
      );
      const request = { context, effectRef: 'cost-effect-' + id, modelConfig: config };
      const saved = evidence.saveJudgmentEvidence(
        { ...request, result, parentTokenAllowance: 1000 },
        deps
      );
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const replans: unknown[] = [];
      const route = () =>
        routing.routeSyntheticJudgment(
          {
            mode: 'offline_fixture',
            evidence: { ...request, address: saved.reference.address },
            originalProposal: candidate.facts,
            gateActionId: 'dot_delegate_work',
            history: [],
          },
          {
            evidence: deps,
            gate: () => {
              throw new Error('Fixture value decision is not effect approval');
            },
            onApplyPlan: () => {
              throw new Error('No effect plan adoption in this fixture');
            },
            onReplan: (plan) => {
              replans.push(plan);
              return undefined;
            },
            onQuestionDraft: (draft) => {
              recordDraft(draft, binding.request_hash);
              return undefined;
            },
          }
        );
      return { request, saved, result, route, replans, binding, snapshot: snap };
    });
  return {
    scope,
    location,
    workRef,
    active,
    snapshot,
    ledgerBytes,
    evaluate,
    questions,
    human,
    reply,
    setRevision: (value: string) => {
      revision = value;
    },
    externalHumanRevision: () =>
      revise(
        500,
        { kind: 'human', id: 'user:fixture-external-owner', role: 'owner' },
        'fixture-external-review'
      ),
  };
}

describe('fixture-only human handoff with real scoped ledger and immutable judgment receipts', () => {
  it('keeps the misleading user/latency binary as reframe without changing original goals or drafting a value question', async () => {
    for (const operation of ['limit_users', 'accept_latency'] as const) {
      const f = fixture();
      const before = f.ledgerBytes();
      const evaluated = await f.evaluate(operation, 'reframe');
      const routed = owner(() => evaluated.route());
      expect(routed.status).toBe('reframed');
      expect(evaluated.replans).toMatchObject([
        {
          original_goals: [{ target_users: 100, max_p95_ms: 500, max_incremental_monthly_cost: 0 }],
        },
      ]);
      expect(f.questions.size).toBe(0);
      expect(f.ledgerBytes()).toBe(before);
    }
  });
  it('holds an unanswered cost question and adopts a repeated draft only once without sending or mutating the ledger', async () => {
    const f = fixture();
    const before = f.ledgerBytes();
    const evaluated = await f.evaluate('add_cost', 'escalate');
    expect(owner(() => evaluated.route()).status).toBe('question_drafted');
    expect(owner(() => evaluated.route()).status).toBe('question_drafted');
    expect(f.questions.size).toBe(1);
    expect(f.reply(undefined, undefined)).toEqual({ status: 'pending' });
    expect(f.active().value).toMatchObject({
      target_users: 100,
      max_p95_ms: 500,
      max_incremental_monthly_cost: 0,
    });
    expect(f.ledgerBytes()).toBe(before);
  });
  it('refuses model-human JSON, copied tokens, wrong tenant, viewer, unknown/stale question and authority-bearing reply fields', async () => {
    const f = fixture();
    const evaluated = await f.evaluate('add_cost', 'escalate');
    owner(() => evaluated.route());
    const question_ref = [...f.questions.keys()][0];
    const payload = { question_ref, budget: 1000 };
    const before = f.ledgerBytes();
    const valid = f.human({ id: 'user:fixture-owner', role: 'owner', tenant: scope.tenant_slug });
    for (const token of [
      undefined,
      { kind: 'human', id: 'user:fixture-owner', role: 'owner' },
      JSON.parse('{"kind":"human","role":"owner"}'),
      { ...valid },
      f.human({ id: 'user:other', role: 'owner', tenant: 'other-tenant' }),
      f.human({
        id: 'user:other-project',
        role: 'owner',
        tenant: scope.tenant_slug,
        project: 'other-project',
      }),
      f.human({
        id: 'user:other-case',
        role: 'owner',
        tenant: scope.tenant_slug,
        caseId: 'other-case',
      }),
      f.human({ id: 'user:viewer', role: 'viewer', tenant: scope.tenant_slug }),
    ])
      expect(f.reply(token, payload).status).toBe('refused');
    expect(f.reply(valid, { ...payload, question_ref: 'unknown' }).status).toBe('refused');
    expect(
      f.reply(valid, { ...payload, decided_by: { kind: 'human', role: 'owner' } }).status
    ).toBe('refused');
    f.setRevision('2');
    expect(f.reply(valid, payload).status).toBe('refused');
    expect(f.ledgerBytes()).toBe(before);
  });
  it('refuses an answer when the actual decision version changed while its question was pending', async () => {
    const f = fixture();
    const evaluated = await f.evaluate('add_cost', 'escalate');
    owner(() => evaluated.route());
    const question_ref = [...f.questions.keys()][0];
    expect(f.externalHumanRevision().status).toBe('recorded');
    const before = f.ledgerBytes();
    const token = f.human({ id: 'user:fixture-owner', role: 'owner', tenant: scope.tenant_slug });
    expect(f.reply(token, { question_ref, budget: 1000 }).status).toBe('refused');
    expect(f.ledgerBytes()).toBe(before);
  });
  it('refuses an old question after the server-owned candidate input changes within the same revision', async () => {
    const f = fixture();
    const first = await f.evaluate('add_cost', 'escalate');
    owner(() => first.route());
    const question_ref = [...f.questions.keys()][0];
    const before = f.ledgerBytes();
    await f.evaluate('limit_users', 'reframe');
    const token = f.human({ id: 'user:fixture-owner', role: 'owner', tenant: scope.tenant_slug });
    expect(f.reply(token, { question_ref, budget: 1000 }).status).toBe('refused');
    expect(f.ledgerBytes()).toBe(before);
  });
  it('records a genuine fixture human cost choice, rereads the new version in the same work, and never reinterprets the old origin or effect approval', async () => {
    const f = fixture();
    const first = await f.evaluate('add_cost', 'escalate');
    owner(() => first.route());
    const originalFile = path.join(root, first.saved.reference.artifact_ref);
    const originalBytes = owner(() => io.safeReadFile(originalFile, { encoding: 'utf8' }));
    const originalAddress = JSON.stringify(first.saved.reference.address);
    const approval = owner(() =>
      approvals.createApprovalRequest('mission_controller', {
        channel: 'autonomy',
        threadTs: 'fixture-human',
        correlationId: f.workRef,
        requestedBy: 'fixture-effect-controller',
        scope: {
          tenant_slug: scope.tenant_slug,
          organization_id: scope.organization_id,
          project_id: scope.project_id,
        },
        draft: {
          title: 'Separate original effect approval',
          summary: JSON.stringify({ work_revision: '1', origin: first.saved.reference.address }),
        },
      })
    );
    const approvalBefore = owner(() =>
      hash(approvals.loadApprovalRequest('autonomy', approval.id))
    );
    const approvalIdsBefore = owner(() =>
      approvals
        .listApprovalRequests({ storageChannels: ['autonomy'], scope })
        .map((record) => record.id)
        .sort()
    );
    const question_ref = [...f.questions.keys()][0];
    const human = f.human({ id: 'user:fixture-owner', role: 'owner', tenant: scope.tenant_slug });
    const recorded = f.reply(human, { question_ref, budget: 1000 });
    expect(recorded.status).toBe('recorded');
    const ledgerAfter = f.ledgerBytes();
    expect(f.reply(human, { question_ref, budget: 1000 }).status).toBe('recorded');
    expect(f.ledgerBytes()).toBe(ledgerAfter);
    expect(f.active().value).toEqual({
      target_users: 100,
      max_p95_ms: 500,
      max_incremental_monthly_cost: 1000,
      currency: 'JPY',
    });
    expect(f.active().decided_by).toEqual({
      kind: 'human',
      id: 'user:fixture-owner',
      role: 'owner',
    });
    f.setRevision('2');
    const second = await f.evaluate('add_cost', 'apply_precedent');
    expect(second.result.assessment).toMatchObject({
      status: 'evaluated',
      verdict: { disposition: 'apply_precedent' },
    });
    expect(second.binding.work_ref).toBe(first.binding.work_ref);
    expect(second.binding.work_revision).toBe('2');
    expect(second.snapshot.snapshot_hash).not.toBe(first.snapshot.snapshot_hash);
    expect(second.saved.reference.address.evaluation_key).not.toBe(
      first.saved.reference.address.evaluation_key
    );
    expect(
      owner(() =>
        evidence.reuseJudgmentEvidence(
          { ...first.request, address: first.saved.reference.address },
          {
            now: () => now,
            readCurrentContext: () => ({
              expectedBinding: second.binding,
              currentSnapshot: { status: 'ready', snapshot: f.snapshot() },
            }),
          }
        )
      ).status
    ).toBe('unavailable');
    expect(owner(() => io.safeReadFile(originalFile, { encoding: 'utf8' }))).toBe(originalBytes);
    expect(JSON.stringify(first.saved.reference.address)).toBe(originalAddress);
    expect(owner(() => hash(approvals.loadApprovalRequest('autonomy', approval.id)))).toBe(
      approvalBefore
    );
    expect(owner(() => approvals.loadApprovalRequest('autonomy', approval.id)?.status)).toBe(
      'pending'
    );
    expect(
      owner(() =>
        approvals
          .listApprovalRequests({ storageChannels: ['autonomy'], scope })
          .map((record) => record.id)
          .sort()
      )
    ).toEqual(approvalIdsBefore);
    expect(owner(() => second.route()).status).toBe('blocked'); // An evaluated value decision cannot adopt an effect plan.
  });
});
