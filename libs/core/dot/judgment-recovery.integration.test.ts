/** Real isolated stores and child-process admission; effects remain a synthetic file port. */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotJudgmentPreEffectDeps } from './dot-judgment-pre-effect.js';
import type { ManagedProcessHandle } from '../managed-process.js';

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp/judgment-recovery-' + randomUUID());
const baseTime = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let decisions: typeof import('../decision-ledger/ledger.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let routing: typeof import('../organization/judgment-routing.js');
let dispatch: typeof import('./dot-dispatch.js');
let executor: typeof import('./dot-executor.js');
let actions: typeof import('./dot-action-ledger.js');
let coordination: typeof import('../workforce/work-coordination.js');
let workLedger: typeof import('../workforce/work-coordination-ledger.js');
let bindings: typeof import('./dot-judgment-binding.js');
let proposals: typeof import('./dot-proposals.js');
let charters: typeof import('./dot-charter.js');
let roles: typeof import('../organization/authority-role-registry.js');
let gate: typeof import('../governance/autonomous-ops-gate.js');
let pre: typeof import('./dot-judgment-pre-effect.js');
let approvals: typeof import('../governance/approval-store.js');
let state: typeof import('./dot-state-paths.js');
let resultStore: typeof import('./dot-result-store.js');
let managed: typeof import('../managed-process.js');
const children: ManagedProcessHandle[] = [];
let serial = 0;
let resultFile = '';
const owner = <T>(fn: () => T) =>
  authority.withExecutionContext(
    'ecosystem_architect',
    fn,
    undefined,
    'synthetic-latency',
    'synthetic-org'
  );
const hash = (value: unknown) => precedents.judgmentCanonicalHash(value);

beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  const copy = (relative: string): void => {
    const from = path.join(sourceRoot, relative),
      to = path.join(root, relative);
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from)) copy(path.join(relative, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration']) copy('knowledge/product/' + name);
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
  const policy = JSON.parse(bootstrap.safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  // Synthetic-only auto scores, identical to T10; production/security policy is unchanged.
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  bootstrap.safeWriteFile(policyPath, JSON.stringify(policy));
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrap.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/synthetic-latency.json'),
    JSON.stringify({
      tenant_slug: 'synthetic-latency',
      display_name: 'Recovery fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeMkdir(path.join(root, 'knowledge/confidential/synthetic-latency/decisions'), {
    recursive: true,
  });
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(baseTime);
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  decisions = await import('../decision-ledger/ledger.js');
  const project = await import('../project/project-registry.js');
  project.saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Recovery protocol only',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof project.saveProjectRecord>[0]);
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  validation = await import('../organization/judgment-validation.js');
  semantic = await import('../organization/semantic-judgment.js');
  evidence = await import('../organization/judgment-evidence.js');
  routing = await import('../organization/judgment-routing.js');
  dispatch = await import('./dot-dispatch.js');
  executor = await import('./dot-executor.js');
  actions = await import('./dot-action-ledger.js');
  coordination = await import('../workforce/work-coordination.js');
  workLedger = await import('../workforce/work-coordination-ledger.js');
  bindings = await import('./dot-judgment-binding.js');
  proposals = await import('./dot-proposals.js');
  charters = await import('./dot-charter.js');
  roles = await import('../organization/authority-role-registry.js');
  gate = await import('../governance/autonomous-ops-gate.js');
  pre = await import('./dot-judgment-pre-effect.js');
  approvals = await import('../governance/approval-store.js');
  state = await import('./dot-state-paths.js');
  resultStore = await import('./dot-result-store.js');
  managed = await import('../managed-process.js');
  resultFile = path.join(
    root,
    state.dotStatePath(
      { scope: latency.createJudgmentLatencyFixture().scope },
      state.DOT_WORK_RESULTS_FILE
    )
  );
}, 60000);
afterEach(() => {
  for (const handle of children.splice(0))
    managed.stopManagedProcess(handle.resourceId, handle.child);
  vi.restoreAllMocks();
  if (resultFile) io.safeRmSync(resultFile, { force: true });
  coordination.clearWorkCoordinationNamespace();
  vi.setSystemTime(baseTime);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bootstrap.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function fixture(operation: 'repair_fixture' | 'add_cost' = 'repair_fixture') {
  const data = latency.createJudgmentLatencyFixture();
  const id = 'recovery-' + ++serial;
  coordination.setWorkCoordinationNamespace(id);
  const parent = coordination.createWorkItem({
    rootDir: root,
    itemId: id,
    title: 'Recover one synthetic effect',
    description: 'No model may retry an unknown effect',
    status: 'ready',
    context: {
      tenant_slug: data.scope.tenant_slug,
      organization_id: data.scope.organization_id,
      project_id: data.scope.project_id,
      work_shape: 'improvement_experiment',
    },
  });
  const location = { tenantSlug: data.scope.tenant_slug, caseId: id };
  const { id: _id, status: _status, case_id: _case, ...seed } = data.decision;
  void _id;
  void _status;
  void _case;
  owner(() => decisions.appendDecisions(location, [seed]));
  const snapshot = () =>
    owner(() =>
      precedents.createJudgmentPrecedentSnapshot(
        { scope: data.scope, selected_case_ids: [id], allowed_case_ids: [id] },
        {
          resolveCaseBinding: () => ({ case_id: id, scope: data.scope }),
          readLedger: () => decisions.readLedger(location),
          resolveGoals: (source) => {
            const record = decisions
              .readLedger(location)
              .find((row) => row.id === source.decision_id)!;
            const value = record.value as typeof data.decision.value;
            if (
              !value ||
              typeof value !== 'object' ||
              hash(value) !== hash(data.decision.value) ||
              hash(record) !== source.decision_version_hash
            )
              throw new Error('Unknown fixed goal mapping or version');
            const { decision_source_key: _key, ...constraints } = data.goal;
            void _key;
            return [
              {
                case_id: source.case_id,
                decision_id: source.decision_id,
                decision_version_hash: source.decision_version_hash,
                constraints,
              },
            ];
          },
        }
      )
    );
  const initial = snapshot();
  if (initial.status !== 'ready') throw new Error(initial.detail);
  const facts = latency.resolveSyntheticLatencyProposal(operation);
  if (facts.status !== 'ready') throw new Error(facts.detail);
  const config = { provider: 'fixture-provider', model: 'fixture-model', maxOutputTokens: 512 };
  const inputFor = (snap: typeof initial.snapshot) =>
    validation.buildJudgmentModelInput(snap, facts.facts, [
      { evidence_key: 'fixed-observation', text: 'Synthetic 65 users, p95 1800ms' },
    ]);
  const bindingFor = (snap: typeof initial.snapshot) => ({
    schema_version: '1' as const,
    work_ref: parent.item_id,
    work_revision: String(parent.version),
    trigger_key: 'recovery-trigger',
    scope_hash: snap.scope_hash,
    ...validation.judgmentModelInputHashes(inputFor(snap)),
    precedent_snapshot_hash: snap.snapshot_hash,
    policy_version: 'semantic-policy',
    rubric_version: 'fixture-rubric',
    evaluator_version: 'fixture-evaluator',
    model_config_hash: semantic.semanticJudgmentModelConfigHash(config),
  });
  const binding = bindingFor(initial.snapshot);
  const request = {
    context: {
      binding,
      scope: data.scope,
      modelInput: inputFor(initial.snapshot),
      snapshot: initial.snapshot,
      requiredGoalKeys: [data.goal.goal_key],
      knownProposalKeys: ['repair_fixture', 'add_cost'],
    },
    effectRef: 'effect-' + id,
    modelConfig: config,
  };
  const current = () => {
    const snap = snapshot();
    return {
      expectedBinding: snap.status === 'ready' ? bindingFor(snap.snapshot) : binding,
      currentSnapshot: snap,
    };
  };
  const evidenceDeps = { now: Date.now, readCurrentContext: current };
  let calls = 0,
    reportedTokens = 0;
  const assess = () =>
    semantic.assessSemanticJudgment(
      {
        ...request.context,
        mode: 'offline_fixture',
        parentDeadlineMs: Date.now() + 15000,
        parentTokenAllowance: Math.min(1000, 2000 - reportedTokens),
        maxOutputTokens: 512,
      },
      {
        now: Date.now,
        schedule: () => () => undefined,
        readCurrentContext: current,
        port: {
          mode: 'offline_fixture',
          provider: config.provider,
          model: config.model,
          invoke: async () => {
            if (calls >= 2 || reportedTokens + 70 > 2000)
              throw new Error('Controller fixture call/token budget exhausted');
            calls++;
            reportedTokens += 70;
            return {
              text: JSON.stringify(
                operation === 'add_cost'
                  ? {
                      disposition: 'escalate',
                      rationale: 'New cost requires a human value choice',
                      question: 'Consider 1000 JPY?',
                      options: [
                        { label: 'Zero cost', consequences: 'Continue investigation' },
                        {
                          label: '1000 JPY',
                          consequences: 'New decision and effect approval required',
                        },
                      ],
                      missing_facts: [],
                    }
                  : {
                      disposition: 'apply_precedent',
                      rationale: 'Keep the fixed goal',
                      precedent_keys: initial.snapshot.evidence_refs.map((ref) => ref.source_key),
                      applicability: ['Synthetic fixture only'],
                    }
              ),
              usage: { input_tokens: 40, output_tokens: 30 },
            };
          },
        },
      }
    );
  const persist = (result: Awaited<ReturnType<typeof assess>>) =>
    evidence.saveJudgmentEvidence({ ...request, result, parentTokenAllowance: 1000 }, evidenceDeps);
  const charter: DotCharter = {
    ...structuredClone(data.charter),
    dot_id: id,
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: {
      ...data.charter.authority,
      authority_role: 'infrastructure_sentinel',
      max_concurrent_delegations: 4,
    },
    runtime: { heartbeat_id: id, semantic_judgment: { mode: 'off' } },
  };
  const charterPath = path.join(
    root,
    'knowledge/confidential/synthetic-latency/dots',
    id + '.json'
  );
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  io.safeWriteFile(charterPath, JSON.stringify(charter));
  const unbound = proposals.normalizeDotProposal({
    title: 'Recover fixed synthetic configuration',
    objective: 'Write the fixed known repair once',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
    target: 'service:synthetic-latency-service',
    intent: 'apply',
  });
  type Saved = Extract<ReturnType<typeof persist>, { status: 'persisted' }>;
  const bind = (saved: Saved) =>
    bindings.bindSyntheticDotJudgmentProposal({
      mode: 'synthetic_fixture',
      charter,
      proposal: unbound,
      scope: data.scope,
      judgmentBinding: binding,
      originReceipt: saved.reference.address,
      effectRef: request.effectRef,
      effectPolicyVersion: gate.getAutonomousOpsPolicy().version,
    });
  const dispatchDeps = {
    rootDir: root,
    now: () => new Date(),
    operationKey: 'operation-' + id,
    feedback: { onRejection: vi.fn() },
    notify: vi.fn(() => true),
  };
  const admit = (bound: ReturnType<typeof bind>, interrupt = false) =>
    dispatch.dispatchDotProposals(charter, [bound], {
      ...dispatchDeps,
      ...(interrupt
        ? {
            createWorkItem: () => {
              throw new Error('crash after admission before item');
            },
          }
        : {}),
    });
  const currentAction = () => actions.currentDotActions(id, { rootDir: root }).at(-1)!;
  const item = () => coordination.getWorkItem(currentAction().work_item_id!, { rootDir: root })!;
  const output = path.join(root, 'active/shared/tmp', id, 'effect.json');
  io.safeMkdir(path.dirname(output), { recursive: true });
  const writes: string[] = [];
  const inbox = vi.fn();
  const run = async (bound: ReturnType<typeof bind>) => {
    const deps: DotJudgmentPreEffectDeps = {
      now: Date.now,
      readExecutionState: () => ({
        charter: charters.rereadOwnDotCharter({ path: charterPath, charter }),
        action: currentAction(),
        item: item(),
        lease: workLedger.withCoordinationRoot(
          root,
          () =>
            coordination
              .listActiveWorkLeases()
              .find((lease) => lease.lease_id === item().lease_id) ?? null
        ),
      }),
      resolveTrustedEffect: (original) => {
        if (hash(original) !== hash(bound)) throw new Error('Original candidate drift');
        return { request, proposalFacts: facts.facts, goals: initial.snapshot.goals };
      },
      readCurrentContext: current,
      hasRole: (role) => Boolean(roles.loadAuthorityRoleIndex(root)[role]),
      checkBounds: (c, p) =>
        dispatch.checkDotProposalBounds(c, p, { rootDir: root, now: () => new Date() }),
      evaluateGate: (c, p) =>
        dispatch.evaluateDotProposalGate(c, p, { rootDir: root, now: () => new Date() }).gate,
      readEffectPolicyVersion: () => gate.getAutonomousOpsPolicy().version,
      loadApproval: (key) => approvals.loadApprovalRequest('autonomy', key),
    };
    const forbidden = async (): Promise<never> => {
      throw new Error('No model/external executor in fixture');
    };
    return executor.executeDotWorkItem(
      charter,
      item(),
      {
        runGoalTurn: forbidden,
        delegateText: forbidden,
        runPipeline: async (_ref, ctx) => {
          const actual = item();
          if (
            ctx.work_item_id !== actual.item_id ||
            ctx.attempt_id !== actual.current_attempt_id ||
            ctx.lease_id !== actual.lease_id
          )
            throw new executor.DotExecutorPreEffectError('Claim context drift', {
              retryable: false,
            });
          const checked = pre.validateDotJudgmentPreEffect(
            {
              mode: 'synthetic_fixture',
              dot_id: charter.dot_id,
              action_ref: currentAction().action_ref,
              item_id: actual.item_id,
              lease_id: String(ctx.lease_id),
              run_id: String(ctx.attempt_id),
              expected_item_version: actual.version,
            },
            deps
          );
          if (checked.status !== 'eligible_observed')
            throw new executor.DotExecutorPreEffectError('Judgment refused before effect', {
              retryable: false,
            });
          io.safeWriteFile(output, JSON.stringify(data.configurations.repair));
          writes.push(actual.current_attempt_id!);
          return { status: 'succeeded', summary: 'Synthetic file effect', executedSteps: 1 };
        },
      },
      {
        rootDir: root,
        now: () => new Date(),
        clock: Date.now,
        throttle: () => 'normal',
        tokenCapReached: () => false,
        appendInbox: inbox,
        audit: () => undefined,
      }
    );
  };
  const replaceDecision = () =>
    owner(() => {
      const original = decisions.readLedger(location).find((row) => row.status === 'active')!;
      const { id: _old, status: _state, case_id: _scope, ...rest } = original;
      void _old;
      void _state;
      void _scope;
      decisions.appendDecisions(location, [
        {
          ...rest,
          basis: [{ ref: 'replacement-human-source', version: '2' }],
          supersedes: original.id,
        },
      ]);
    });
  const active = [{ path: charterPath, charter }];
  const reap = () =>
    executor.reapStrandedDotWorkItems(active, {
      rootDir: root,
      now: () => new Date(),
      appendInbox: inbox,
      audit: () => undefined,
    });
  return {
    id,
    data,
    parent,
    initial,
    request,
    binding,
    charter,
    charterPath,
    evidenceDeps,
    assess,
    persist,
    bind,
    admit,
    dispatchDeps,
    currentAction,
    item,
    run,
    reap,
    replaceDecision,
    writes,
    inbox,
    output,
    calls: () => calls,
    reportedTokens: () => reportedTokens,
  };
}

async function raceAdmission(
  f: Awaited<ReturnType<typeof fixture>>,
  bound: ReturnType<typeof f.bind>,
  childScenario: 'admit' | 'exit_zero_before_ready' | 'exit_nonzero_before_ready' = 'admit'
) {
  const contract = {
    charter: f.charter,
    bound,
    operationKey: f.dispatchDeps.operationKey,
    namespace: f.id,
    now: new Date().toISOString(),
  };
  const contractPath = path.join(root, 'active/shared/tmp', f.id, 'child.json');
  io.safeWriteFile(contractPath, JSON.stringify(contract));
  const moduleUrl = (name: string) => pathToFileURL(path.join(sourceRoot, 'libs/core', name)).href;
  const code = `${childScenario === 'admit' ? '' : `process.exit(${childScenario === 'exit_zero_before_ready' ? 0 : 7});`}
import * as io from ${JSON.stringify(moduleUrl('secure-io.ts'))};
import * as dispatch from ${JSON.stringify(moduleUrl('dot/dot-dispatch.ts'))};
import * as work from ${JSON.stringify(moduleUrl('workforce/work-coordination.ts'))};
const c=JSON.parse(io.safeReadFile(${JSON.stringify(contractPath)},{encoding:'utf8'}));
work.setWorkCoordinationNamespace(c.namespace);
process.stdin.once('data',()=>{try{const r=dispatch.dispatchDotProposals(c.charter,[c.bound],{rootDir:${JSON.stringify(root)},operationKey:c.operationKey,now:()=>new Date(c.now),notify:()=>true});process.stdout.write(JSON.stringify({ok:true,pid:process.pid,records:r.records.map(x=>({action_ref:x.action_ref,status:x.status})),duplicates:r.duplicates})+String.fromCharCode(10));}catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e)})+String.fromCharCode(10));}finally{process.exit(0);}});
process.stdout.write('READY'+String.fromCharCode(10));`;
  const pending: {
    handle: ManagedProcessHandle;
    ready: Promise<void>;
    result: Promise<{ ok: boolean; pid: number; error?: string }>;
  }[] = [];
  try {
    for (let childIndex = 0; childIndex < 2; childIndex++) {
      const handle = managed.spawnManagedProcess({
        resourceId: 'recovery-child-' + randomUUID(),
        kind: 'service',
        ownerId: f.id,
        ownerType: 'test',
        command: process.execPath,
        args: [
          '--import',
          path.join(sourceRoot, 'scripts/ts-loader.mjs'),
          '--input-type=module',
          '-e',
          code,
        ],
        spawnOptions: {
          cwd: root,
          env: { ...process.env, KYBERION_ROOT: root },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      });
      children.push(handle);
      let stdout = '',
        stderr = '';
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      void ready.catch(() => {});
      handle.child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('READY\n')) readyResolve();
      });
      handle.child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const result = new Promise<{ ok: boolean; pid: number; error?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error('Recovery child deadline: ' + stderr + stdout);
            readyReject(error);
            reject(error);
            managed.stopManagedProcess(handle.resourceId, handle.child);
          }, 60000);
          handle.child.once('error', (error) => {
            clearTimeout(timer);
            readyReject(error);
            reject(error);
          });
          handle.child.stdin?.once('error', (error) => {
            clearTimeout(timer);
            readyReject(error);
            reject(error);
          });
          handle.child.once('close', (exit) => {
            clearTimeout(timer);
            if (exit !== 0) {
              const error = new Error('Recovery child exit: ' + stderr + stdout);
              readyReject(error);
              reject(error);
              return;
            }
            const line = stdout
              .trim()
              .split('\n')
              .find((value) => value.startsWith('{"ok":'));
            if (!line) {
              const error = new Error('No child receipt: ' + stdout + stderr);
              readyReject(error);
              reject(error);
              return;
            }
            if (!stdout.includes('READY\n')) {
              const error = new Error('Child closed before READY: ' + stdout + stderr);
              readyReject(error);
              reject(error);
              return;
            }
            try {
              resolve(JSON.parse(line));
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      void result.catch(() => {});
      pending.push({ handle, ready, result });
    }
    await Promise.all(pending.map((p) => p.ready));
    for (const p of pending) p.handle.child.stdin?.write('go\n');
    return await Promise.all(pending.map((p) => p.result));
  } finally {
    for (const handle of children.filter((child) => !pending.some((p) => p.handle === child))) {
      managed.stopManagedProcess(handle.resourceId, handle.child);
    }
    for (const p of pending) managed.stopManagedProcess(p.handle.resourceId, p.handle.child);
  }
}

describe(
  'five crash boundaries and exact recovery of synthetic semantic work',
  { timeout: 120000 },
  () => {
    it('crash after snapshot rechecks the real replaced decision before invoking any model or admitting work', async () => {
      const f = await fixture();
      expect(f.calls()).toBe(0);
      f.replaceDecision();
      const result = await f.assess();
      expect(result.assessment.status).toBe('unavailable');
      expect(f.calls()).toBe(0);
      expect(actions.currentDotActions(f.id, { rootDir: root })).toEqual([]);
      expect(f.writes).toEqual([]);
    });
    it('crash after model response permits bounded reinvocation but adopts only one immutable receipt', async () => {
      const f = await fixture();
      await f.assess();
      expect(f.calls()).toBe(1);
      const second = await f.assess();
      const saved = f.persist(second);
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const again = f.persist(second);
      expect(again).toMatchObject({
        status: 'persisted',
        adopted_existing: true,
        reference: saved.reference,
      });
      expect(f.calls()).toBe(2);
      expect(f.reportedTokens()).toBe(140);
      expect(f.writes).toEqual([]);
      expect(coordination.listWorkItems({}, { rootDir: root })).toHaveLength(1);
    });
    it('crash after receipt storage repairs required trace, retains original bytes and refuses expired/replaced validation', async () => {
      const f = await fixture();
      const result = await f.assess();
      const write = io.safeWriteFile;
      vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
        if (String(file).includes('/log/semantic-judgment-trace/'))
          throw new Error('Crash after receipt before trace');
        return write(file, data, options);
      });
      expect(f.persist(result).status).toBe('unavailable');
      vi.restoreAllMocks();
      const parent = evidence.judgmentEvidenceParent({
        scope: f.data.scope,
        binding: f.binding,
        effectRef: f.request.effectRef,
      });
      const saved = evidence.resolveLatestJudgmentEvidence(
        { ...f.request, parent },
        f.evidenceDeps
      );
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const file = path.join(root, saved.reference.artifact_ref),
        bytes = io.safeReadFile(file, { encoding: 'utf8' });
      vi.setSystemTime(baseTime + 300000);
      expect(
        evidence.resolveLatestJudgmentEvidence({ ...f.request, parent }, f.evidenceDeps).status
      ).toBe('unavailable');
      const fresh = f.persist(await f.assess());
      if (fresh.status !== 'persisted') throw new Error(fresh.detail);
      expect(fresh.reference.address.attempt).toBe(2);
      expect(io.safeReadFile(file, { encoding: 'utf8' })).toBe(bytes);
      f.replaceDecision();
      expect(
        evidence.resolveLatestJudgmentEvidence({ ...f.request, parent }, f.evidenceDeps).status
      ).toBe('unavailable');
      expect(f.writes).toEqual([]);
    });
    it('crash after admission restores one real WorkItem on repeated webhook and preserves its immutable origin', async () => {
      const f = await fixture();
      const saved = f.persist(await f.assess());
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const bound = f.bind(saved),
        origin = JSON.stringify(bound.semantic_judgment);
      expect(f.admit(bound, true).records[0].status).toBe('admitted');
      expect(coordination.listWorkItems({}, { rootDir: root })).toHaveLength(1);
      f.admit(bound);
      const item = f.item();
      f.admit(bound);
      expect(f.item().item_id).toBe(item.item_id);
      expect(coordination.listWorkItems({}, { rootDir: root })).toHaveLength(2);
      expect(JSON.stringify(f.currentAction().semantic_judgment)).toBe(origin);
      expect((await f.run(bound)).status).toBe('done');
      expect((await f.run(bound)).status).toBe('skipped');
      expect(f.writes).toHaveLength(1);
    });
    it('effect before durable result leaves a real held claim, then real expiry publishes negative evidence and archives unknown effect without replay', async () => {
      const f = await fixture();
      const saved = f.persist(await f.assess());
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const bound = f.bind(saved);
      f.admit(bound);
      const append = io.safeAppendFileSync;
      let crashed = false;
      vi.spyOn(io, 'safeAppendFileSync').mockImplementation((file, data, options) => {
        if (!crashed && String(file) === resultFile) {
          crashed = true;
          throw new Error('Crash after file effect before durable result');
        }
        return append(file, data, options);
      });
      await expect(f.run(bound)).rejects.toThrow('Crash after file effect');
      expect(f.writes).toHaveLength(1);
      expect(io.safeReadFile(f.output, { encoding: 'utf8' })).toBe(
        JSON.stringify(f.data.configurations.repair)
      );
      const held = f.item();
      expect(held.status).toBe('in_progress');
      expect(held.effect_ownership?.state).toBe('held');
      const lease = workLedger.withCoordinationRoot(root, () =>
        workLedger.currentLeaseRecords().find((value) => value.lease_id === held.lease_id)!
      );
      expect(lease.status).toBe('active');
      expect(lease.released_at).toBeUndefined();
      vi.restoreAllMocks();
      vi.setSystemTime(Date.parse(lease.expires_at) + 1);
      f.reap();
      expect(f.item()).toMatchObject({ status: 'archived', effect_ownership: { state: 'held' } });
      const state = resultStore.readConfidentialDotResultState(f.charter, { rootDir: root });
      expect(state).toMatchObject([{ status: 'blocked', mode: 'escalated' }]);
      f.reap();
      expect((await f.run(bound)).status).toBe('skipped');
      expect(f.writes).toHaveLength(1);
      expect(f.inbox).toHaveBeenCalledTimes(1);
      const expired = workLedger.withCoordinationRoot(root, () =>
        workLedger.currentLeaseRecords().find((value) => value.lease_id === held.lease_id)!
      );
      expect(expired.status).toBe('expired');
      expect(expired.released_at).toBeUndefined();
    });
    it('two real managed child wakes under one root/namespace/key converge on one admitted action and WorkItem', async () => {
      const f = await fixture();
      const saved = f.persist(await f.assess());
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const bound = f.bind(saved);
      const results = await raceAdmission(f, bound);
      expect(
        results.every((result) => result.ok),
        JSON.stringify(results)
      ).toBe(true);
      expect(new Set(results.map((result) => result.pid)).size).toBe(2);
      expect(actions.currentDotActions(f.id, { rootDir: root })).toHaveLength(1);
      expect(coordination.listWorkItems({}, { rootDir: root })).toHaveLength(2);
      expect(f.writes).toEqual([]);
    });
    it.each(['exit_zero_before_ready', 'exit_nonzero_before_ready'] as const)(
      'managed child %s rejects readiness and tears down without unhandled rejection',
      async (scenario) => {
        const f = await fixture();
        const saved = f.persist(await f.assess());
        if (saved.status !== 'persisted') throw new Error(saved.detail);
        await expect(raceAdmission(f, f.bind(saved), scenario)).rejects.toThrow(
          /No child receipt|Recovery child exit/
        );
        expect(actions.currentDotActions(f.id, { rootDir: root })).toEqual([]);
        expect(f.writes).toEqual([]);
      }
    );
    it('duplicate value-choice webhooks adopt one local question draft and no work or external effect', async () => {
      const f = await fixture('add_cost');
      const saved = f.persist(await f.assess());
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const adopted = new Map<string, unknown>();
      let callbacks = 0;
      const route = () =>
        routing.routeSyntheticJudgment(
          {
            mode: 'offline_fixture',
            evidence: { ...f.request, address: saved.reference.address },
            originalProposal: f.request.context.modelInput.proposal,
            gateActionId: 'dot_delegate_work',
            history: [],
          },
          {
            evidence: f.evidenceDeps,
            gate: () => {
              throw new Error('Question is not effect authority');
            },
            onApplyPlan: () => {
              throw new Error('No effect');
            },
            onReplan: () => undefined,
            onQuestionDraft: (draft) => {
              callbacks++;
              const key = hash({ binding: f.binding, effect: f.request.effectRef });
              if (!adopted.has(key)) adopted.set(key, draft);
              return undefined;
            },
          }
        );
      expect(route().status).toBe('question_drafted');
      expect(route().status).toBe('question_drafted');
      expect(callbacks).toBe(2);
      expect(adopted.size).toBe(1);
      expect(actions.currentDotActions(f.id, { rootDir: root })).toEqual([]);
      expect(coordination.listWorkItems({}, { rootDir: root })).toHaveLength(1);
      expect(f.writes).toEqual([]);
    });
  }
);
