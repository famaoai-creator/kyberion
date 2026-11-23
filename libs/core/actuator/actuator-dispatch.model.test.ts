import { describe, expect, it, vi } from 'vitest';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../testing/finite-state-checker.js';
import {
  asActuatorContextPatch,
  buildSingleOpPipelinePayload,
  defineActuator,
  isActuatorContextPatch,
  normalizeCatalogDispatchOutput,
  planActuatorDryRun,
  resolveCliActionKind,
  runActuatorPipeline,
  runActuatorStepSequence,
  stripActuatorContextPatchBrand,
  withCatalogInputContract,
  type ActuatorResult,
} from './actuator-sdk.js';
import {
  buildRetiredActuatorOpError,
  determineActuatorStepType,
  listPluginActuatorOperations,
  loadActuatorOpRegistry,
  registerPluginActuatorOperation,
  resetPluginActuatorOperationsForTests,
  resolveActuatorModulePath,
  resolveActuatorOperationTimeout,
} from './actuator-op-registry.js';
import {
  resolveCapabilityEffect,
  resolveOpEffect,
  type ActuatorManifestCapability,
} from './actuator-manifest-index.js';
import { registerOpPreflightListener } from '../pipeline/op-preflight.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   - the domain handler runs only after resolve + admission + validation
//   - dry-run never invokes a non-capture handler; capture always observes
//   - dispatch, admission, and classification degrade fail-closed
//
// Abstraction: one op dispatch lifecycle — resolve → preflight → validate →
// dry-run plan → invoke — per step kind and dry-run flag. Retries, context
// payloads, sandbox enforcement, and real actuator side effects are outside
// the model. The spec below is written independently of the implementation;
// production conformance is checked by enumeration afterwards.

type StepKind = 'capture' | 'transform' | 'apply' | 'control';
const KINDS: readonly StepKind[] = ['capture', 'transform', 'apply', 'control'];

type Phase =
  'resolve' | 'preflight' | 'validate' | 'plan' | 'invoke' | 'done' | 'failed' | 'denied';

interface DispatchState {
  phase: Phase;
  kind: StepKind;
  dry: boolean;
  resolved: boolean;
  admitted: boolean;
  validated: boolean;
  invoked: number;
  outcome?: 'succeeded' | 'failed' | 'validate-only';
}

const initial = (kind: StepKind, dry: boolean): DispatchState => ({
  phase: 'resolve',
  kind,
  dry,
  resolved: false,
  admitted: false,
  validated: false,
  invoked: 0,
});

function specNext(state: DispatchState): readonly ModelStep<DispatchState>[] {
  switch (state.phase) {
    case 'resolve':
      return [
        { action: 'resolve:known', state: { ...state, phase: 'preflight', resolved: true } },
        { action: 'resolve:unknown', state: { ...state, phase: 'failed', outcome: 'failed' } },
      ];
    case 'preflight':
      return [
        { action: 'preflight:allow', state: { ...state, phase: 'validate', admitted: true } },
        { action: 'preflight:deny', state: { ...state, phase: 'denied' } },
      ];
    case 'validate':
      return [
        { action: 'validate:accept', state: { ...state, phase: 'plan', validated: true } },
        { action: 'validate:reject', state: { ...state, phase: 'failed', outcome: 'failed' } },
      ];
    case 'plan':
      // Capture is always side-effect-free observation: the handler runs even
      // under dry-run. Non-capture dry-run validates only.
      if (state.kind === 'capture')
        return [{ action: 'plan:invoke', state: { ...state, phase: 'invoke' } }];
      if (state.dry)
        return [
          {
            action: 'plan:validate-only',
            state: { ...state, phase: 'done', outcome: 'validate-only' },
          },
        ];
      return [{ action: 'plan:invoke', state: { ...state, phase: 'invoke' } }];
    case 'invoke':
      return [
        {
          action: 'handler:ok',
          state: { ...state, phase: 'done', invoked: 1, outcome: 'succeeded' },
        },
        {
          action: 'handler:throw',
          state: { ...state, phase: 'failed', invoked: 1, outcome: 'failed' },
        },
      ];
    default:
      return [];
  }
}

const model: SafetyModel<DispatchState> = {
  initial: KINDS.flatMap((kind) => [initial(kind, false), initial(kind, true)]),
  key: (state) => JSON.stringify(state),
  next: specNext,
  invariants: {
    'unresolved ops never invoke or succeed': (s) =>
      s.resolved || (s.invoked === 0 && s.phase !== 'done'),
    'handler requires resolution and admission': (s) =>
      s.invoked === 0 || (s.resolved && s.admitted),
    'handler requires accepted input': (s) => s.invoked === 0 || s.validated,
    'dry-run never invokes a non-capture handler': (s) =>
      !(s.dry && s.kind !== 'capture') || s.invoked === 0,
    'capture still observes under dry-run': (s) =>
      !(s.dry && s.kind === 'capture' && s.phase === 'done') || s.invoked === 1,
    'denial never invokes': (s) => s.admitted || s.invoked === 0,
    'handler runs at most once per dispatch': (s) => s.invoked <= 1,
    'success implies invocation or declared dry-run': (s) =>
      s.phase !== 'done' || s.invoked === 1 || (s.dry && s.kind !== 'capture'),
    'validate-only only under dry-run of a non-capture op': (s) =>
      s.outcome !== 'validate-only' || (s.dry && s.kind !== 'capture' && s.invoked === 0),
  },
};

describe('actuator dispatch finite-state specification', () => {
  it('exhausts the reachable graph without a safety violation', () => {
    const result = checkFiniteStateSafety(model);
    expect(result).toEqual({ status: 'verified', visited: 74, transitions: 66 });
  });

  it('detects a validation-bypass mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) =>
        state.phase === 'preflight'
          ? [
              ...specNext(state),
              {
                action: 'preflight:skip-validation',
                state: { ...state, phase: 'invoke' as const, admitted: true },
              },
            ]
          : specNext(state),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('handler requires accepted input');
    expect(result.trace?.map((step) => step.action)).toContain('preflight:skip-validation');
  });

  it('detects a dry-run handler mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) =>
        state.phase === 'plan' && state.dry && state.kind !== 'capture'
          ? [
              ...specNext(state),
              { action: 'plan:dry-run-executes', state: { ...state, phase: 'invoke' as const } },
            ]
          : specNext(state),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('dry-run never invokes a non-capture handler');
  });

  it('detects an unknown-op success mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) =>
        state.phase === 'resolve'
          ? [
              ...specNext(state),
              {
                action: 'resolve:unknown-succeeds',
                state: { ...state, phase: 'done' as const, outcome: 'succeeded' as const },
              },
            ]
          : specNext(state),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('unresolved ops never invoke or succeed');
  });
});

// ---- Production conformance: the dispatch ABI over every outcome assignment ----
//
// The ABI has no preflight stage (that boundary is checked separately through
// runActuatorPipeline), so admission is always granted in this slice.

function specDispatchOutcome(
  kind: StepKind,
  dry: boolean,
  outcomes: { known: boolean; valid: boolean; handlerOk: boolean }
): { ok: boolean; status: string; invoked: number; dryRun: boolean } {
  if (!outcomes.known) return { ok: false, status: 'failed', invoked: 0, dryRun: false };
  if (!outcomes.valid) return { ok: false, status: 'failed', invoked: 0, dryRun: false };
  if (kind !== 'capture' && dry) return { ok: true, status: 'succeeded', invoked: 0, dryRun: true };
  return outcomes.handlerOk
    ? { ok: true, status: 'succeeded', invoked: 1, dryRun: false }
    : { ok: false, status: 'failed', invoked: 1, dryRun: false };
}

describe('defineActuator dispatch conformance', () => {
  for (const kind of KINDS) {
    // 32 assignments per kind: known/valid/handlerOk × dryRun.
    for (let mask = 0; mask < 32; mask++) {
      const outcomes = {
        known: (mask & 1) !== 0,
        valid: (mask & 2) !== 0,
        handlerOk: (mask & 4) !== 0,
      };
      const dry = (mask & 8) !== 0;
      it(`kind=${kind} mask=${mask} matches the spec`, async () => {
        const expected = specDispatchOutcome(kind, dry, outcomes);
        const handler = vi.fn(() => {
          if (!outcomes.handlerOk) throw new Error('handler failure');
          return 'output';
        });
        const actuator = defineActuator({
          id: 'model-actuator',
          ops: {
            probe: {
              kind,
              validateInput: (value: unknown) => {
                if (!outcomes.valid) throw new Error('invalid input');
                return value;
              },
              handler,
            },
          },
        });
        const result: ActuatorResult = await actuator.dispatch(
          outcomes.known ? 'probe' : 'ghost',
          {},
          { dryRun: dry }
        );
        expect(result.ok).toBe(expected.ok);
        expect(result.status).toBe(expected.status);
        expect(handler).toHaveBeenCalledTimes(expected.invoked);
        if (expected.dryRun) {
          expect(result.output).toMatchObject({ dry_run: true, mode: 'validate-only', kind });
        }
        if (!outcomes.known) expect(result.error).toContain('[UNKNOWN_OP]');
      });
    }
  }
});

// ---- Production conformance: the shared preflight admission boundary ----

describe('runActuatorPipeline admission conformance', () => {
  // Admission rule: the step executes iff preflight allows AND (no approval
  // is required OR a trusted grant exists). Five admission scenarios cover
  // the lattice; a throwing handler confirms failure still propagates.
  for (const scenario of [
    { name: 'allow', block: false, approval: 'none' },
    { name: 'preflight-block', block: true, approval: 'none' },
    { name: 'approval-granted', block: false, approval: 'granted' },
    { name: 'approval-denied', block: false, approval: 'denied' },
    { name: 'block-overrides-grant', block: true, approval: 'granted' },
  ] as const) {
    for (const handlerOk of [true, false]) {
      it(`scenario=${scenario.name} handlerOk=${handlerOk}`, async () => {
        const admitted = !scenario.block && scenario.approval !== 'denied';
        const unregister = scenario.block
          ? registerOpPreflightListener({
              id: 'test:model-admission-block',
              order: -100,
              run: () => ({ decision: 'block', reason: 'model blocked' }),
            })
          : () => {};
        const execute = vi.fn(async (_op: string, _params: object, context: object) => {
          if (!handlerOk) throw new Error('handler failure');
          return { ...(context as object), ran: true } as Record<string, unknown>;
        });
        try {
          const params =
            scenario.approval === 'none' ? {} : { _approval_required: true, value: 'v' };
          const run = runActuatorPipeline({
            actuatorId: 'model',
            steps: [{ op: 'probe', params }],
            context: {},
            ...(scenario.approval === 'granted'
              ? { approvalGranted: () => true, hasHuman: true }
              : {}),
            execute: execute as never,
          });
          if (!admitted) {
            await expect(run).rejects.toThrow(/^\[OP_PREFLIGHT_/);
          } else if (!handlerOk) {
            await expect(run).rejects.toThrow('handler failure');
          } else {
            await expect(run).resolves.toEqual({ ran: true });
          }
          expect(execute).toHaveBeenCalledTimes(admitted ? 1 : 0);
        } finally {
          unregister();
        }
      });
    }
  }
});

// ---- Production conformance: ordered sequence accounting ----

describe('runActuatorStepSequence conformance', () => {
  // Spec: steps run in order; the first failure stops admission of later
  // steps; status fails iff an attempted step failed; context reflects only
  // the successful prefix.
  for (let mask = 0; mask < 8; mask++) {
    it(`failure mask=${mask}`, async () => {
      const fails = [(mask & 1) !== 0, (mask & 2) !== 0, (mask & 4) !== 0];
      const firstFailure = fails.indexOf(true);
      const attempted = firstFailure < 0 ? 3 : firstFailure + 1;
      const executed: string[] = [];
      const result = await runActuatorStepSequence({
        actuatorId: 'model',
        steps: [{ op: 's0' }, { op: 's1' }, { op: 's2' }],
        context: { count: 0 },
        execute: async (op, _params, context) => {
          executed.push(op);
          if (fails[Number(op.slice(1))]) throw new Error(`${op} failed`);
          return { count: (context.count as number) + 1 };
        },
      });
      expect(executed).toHaveLength(attempted);
      expect(result.results).toHaveLength(attempted);
      expect(result.status).toBe(firstFailure < 0 ? 'succeeded' : 'failed');
      expect(result.results.filter((r) => r.status === 'failed')).toHaveLength(
        firstFailure < 0 ? 0 : 1
      );
      expect(result.context.count).toBe(firstFailure < 0 ? 3 : firstFailure);
    });
  }
});

// ---- Production conformance: pure classification and planning tables ----

describe('dry-run plan and action-kind tables', () => {
  it('matches the spec table for every kind × dry-run assignment', () => {
    for (const kind of KINDS) {
      for (const dry of [false, true]) {
        const expected =
          kind === 'capture'
            ? { skipHandler: false, mode: 'capture' }
            : dry
              ? { skipHandler: true, mode: 'validate-only' }
              : { skipHandler: false, mode: 'execute' };
        expect(planActuatorDryRun({ kind, dryRun: dry })).toEqual(expected);
      }
    }
  });

  it('classifies every capture verb, namespaced verb, and unknown action', () => {
    for (const name of [
      'get',
      'list',
      'status',
      'read',
      'capture',
      'inspect',
      'describe',
      'show',
      'health',
    ]) {
      expect(resolveCliActionKind({ action: name })).toBe('capture');
      expect(resolveCliActionKind({ op: `any-domain:${name}` })).toBe('capture');
    }
    for (const name of ['set', 'write', 'mutate', '', 'pipeline']) {
      expect(resolveCliActionKind({ action: name })).toBe('apply');
    }
    for (const kind of KINDS) {
      expect(resolveCliActionKind(buildSingleOpPipelinePayload('probe', {}, kind))).toBe(kind);
    }
  });
});

describe('capability effect resolution', () => {
  const READ_VERBS = new Set(['get', 'list', 'read', 'query', 'search', 'head', 'options']);
  const DECLARED: Array<ActuatorManifestCapability['effect'] | undefined> = [
    undefined,
    'read',
    'write',
    'egress',
    'none',
  ];
  const VERBS = [
    'get',
    'list',
    'read',
    'query',
    'search',
    'head',
    'options',
    'GET',
    'post',
    'write',
    '',
    undefined,
  ];

  it('matches the fail-safe table for all 120 capability/input assignments', () => {
    for (const effect of DECLARED) {
      for (const hasEffectFrom of [false, true]) {
        for (const verb of VERBS) {
          const capability: ActuatorManifestCapability = {
            op: 'probe',
            platforms: [],
            ...(effect ? { effect } : {}),
            ...(hasEffectFrom ? { effect_from: 'method' } : {}),
          };
          const input = verb === undefined ? {} : { method: verb };
          const expected =
            effect === 'egress' &&
            hasEffectFrom &&
            typeof verb === 'string' &&
            READ_VERBS.has(verb.trim().toLowerCase())
              ? 'read'
              : (effect ?? 'write');
          expect(
            resolveCapabilityEffect(capability, input),
            `effect=${effect} from=${hasEffectFrom} verb=${verb}`
          ).toBe(expected);
        }
      }
    }
  });
});

describe('module path containment', () => {
  const IDS = ['demo-actuator', 'x', 'a1', 'UPPER', 'bad id', 'a/b', '..', '-lead', 'trail-', ''];
  const ENTRYPOINTS = [
    'index.js',
    'src/index.ts',
    'sub/mod.mjs',
    '.hidden.js',
    '/abs.js',
    '../escape.js',
    'a/../b.js',
    './x.js',
    'a/./b.js',
    '',
    '   ',
    'a\\b\\c.js',
    'a\\..\\x.js',
    'file',
    'a..b.js',
    'a.b/c.d/e.ts',
  ];

  function specModulePath(actuatorId: string, entrypoint: string): string | null {
    const id = actuatorId.trim();
    const normalized = entrypoint.trim().replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (
      !id ||
      !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
      !normalized ||
      normalized.startsWith('/') ||
      segments.some((segment) => segment === '..' || segment === '.')
    ) {
      return null;
    }
    return `dist/libs/actuators/${id}/${normalized.replace(/(\.[^./]+)?$/, '.js')}`;
  }

  it('accepts exactly the contained paths and escapes nothing', () => {
    for (const id of IDS) {
      for (const entrypoint of ENTRYPOINTS) {
        const expected = specModulePath(id, entrypoint);
        if (expected === null) {
          expect(() => resolveActuatorModulePath(id, entrypoint)).toThrow(
            '[OP_RESOLUTION_MANIFEST]'
          );
        } else {
          const resolved = resolveActuatorModulePath(id, entrypoint);
          expect(resolved).toBe(expected);
          expect(resolved.startsWith(`dist/libs/actuators/${id.trim()}/`)).toBe(true);
          expect(resolved.endsWith('.js')).toBe(true);
          expect(resolved.split('/').every((segment) => segment !== '..' && segment !== '.')).toBe(
            true
          );
        }
      }
    }
  });
});

// ---- Production conformance: governed registry data invariants ----

describe('op registry data invariants', () => {
  const registry = loadActuatorOpRegistry();

  it('keeps every domain pool disjoint and classifies each declared op as its pool kind', () => {
    for (const [domain, pools] of Object.entries(registry.domains)) {
      const expected = new Map<string, StepKind>();
      for (const kind of KINDS) {
        for (const op of pools[kind as keyof typeof pools] ?? []) {
          expect(expected.has(op), `${domain}:${op} declared in two pools`).toBe(false);
          expected.set(op, kind);
        }
      }
      for (const [op, kind] of expected) {
        expect(determineActuatorStepType(domain, op)).toBe(kind);
      }
    }
  });

  it('keeps shared pools mutually disjoint and classifies each shared op for an unknown domain', () => {
    const shared = new Map<string, string>();
    for (const kind of ['capture', 'transform', 'apply'] as const) {
      for (const op of registry[`shared_${kind}_ops`]) {
        expect(shared.has(op), `shared op ${op} declared twice`).toBe(false);
        shared.set(op, kind);
      }
    }
    for (const [op, kind] of shared) {
      expect(determineActuatorStepType('no-such-domain', op)).toBe(kind);
    }
  });

  it('lets a domain pool specialize a shared op and pins the specialization set', () => {
    const shared = new Map<string, string>();
    for (const kind of ['capture', 'transform', 'apply'] as const) {
      for (const op of registry[`shared_${kind}_ops`]) shared.set(op, kind);
    }
    const specializations: string[] = [];
    for (const [domain, pools] of Object.entries(registry.domains)) {
      for (const kind of KINDS) {
        for (const op of pools[kind as keyof typeof pools] ?? []) {
          const sharedKind = shared.get(op);
          if (sharedKind && sharedKind !== kind) {
            // Domain declaration wins; the set is pinned so drift is visible.
            specializations.push(`${domain}:${op} ${kind}>${sharedKind}`);
            expect(determineActuatorStepType(domain, op)).toBe(kind);
          }
        }
      }
    }
    expect(specializations.sort()).toEqual([
      'media:document_diagram_render_from_brief apply>transform',
      'vcs:fetch apply>capture',
      'vcs:log capture>apply',
    ]);
  });

  it('keeps retired ops unresolvable, named with their replacement, and unregisterable by plugins', () => {
    const retired = buildRetiredActuatorOpError('orchestrator', 'execute_task_plan');
    expect(retired?.message).toContain('was retired on');
    expect(retired?.message).toContain('task_plan_to_next_tasks');
    expect(() => determineActuatorStepType('orchestrator', 'execute_task_plan')).toThrow(
      /was retired on .+ Use /
    );
    expect(() =>
      registerPluginActuatorOperation({
        domain: 'orchestrator',
        action: 'execute_task_plan',
        stepType: 'apply',
        pluginId: 'model-plugin',
        modulePath: 'model/plugin.js',
        handler: async () => ({ handled: true, ctx: {} }),
      })
    ).toThrow('[OP_REGISTRY_PLUGIN_CONFIG]');
  });

  it('registers plugin ops under their declared kind and unregisters them cleanly', () => {
    try {
      const dispose = registerPluginActuatorOperation({
        domain: 'model-domain',
        action: 'probe',
        stepType: 'transform',
        pluginId: 'model-plugin',
        modulePath: 'model/plugin.js',
        handler: async () => ({ handled: true, ctx: {} }),
      });
      expect(determineActuatorStepType('model-domain', 'probe')).toBe('transform');
      expect(
        listPluginActuatorOperations().some(
          (entry) => entry.domain === 'model-domain' && entry.action === 'probe'
        )
      ).toBe(true);
      dispose();
      expect(listPluginActuatorOperations()).toHaveLength(0);
    } finally {
      resetPluginActuatorOperationsForTests();
    }
  });
});

// ---- Production conformance: catalog dispatch output normalization ----

describe('catalog dispatch output normalization', () => {
  const ENVELOPES = {
    full: {
      status: 'succeeded',
      results: [],
      context: { last_capture: 'C', last_transform: 'T', got: 'G' },
      total_steps: 1,
    },
    none: { status: 'succeeded', results: [], context: { other: 1 }, total_steps: 1 },
  };

  it('collapses every envelope shape through the spec channel rules', () => {
    for (const kind of KINDS) {
      for (const exportAs of [undefined, '', 'got', 'missing', ' got ']) {
        for (const envelope of Object.values(ENVELOPES)) {
          const params = exportAs === undefined ? {} : { export_as: exportAs };
          const explicit = exportAs?.trim() || undefined;
          const channel =
            explicit ??
            (kind === 'capture'
              ? 'last_capture'
              : kind === 'transform'
                ? 'last_transform'
                : undefined);
          const output = normalizeCatalogDispatchOutput(envelope, kind, params);
          if (channel && Object.hasOwn(envelope.context, channel)) {
            expect(output).toBe(envelope.context[channel as keyof typeof envelope.context]);
          } else {
            expect(isActuatorContextPatch(output)).toBe(true);
            expect(output).toMatchObject(envelope.context);
          }
        }
      }
    }
  });

  it('passes non-envelope payloads through unchanged', () => {
    for (const value of [42, 'text', { status: 'x' }, { context: { a: 1 } }, null]) {
      expect(normalizeCatalogDispatchOutput(value, 'capture', {})).toBe(value);
    }
  });

  it('brands, detects, and strips context patches as a round trip', () => {
    const patch = asActuatorContextPatch({ seed: 1 });
    expect(isActuatorContextPatch(patch)).toBe(true);
    expect(isActuatorContextPatch({ seed: 1 })).toBe(false);
    expect(isActuatorContextPatch('patch')).toBe(false);
    expect(stripActuatorContextPatchBrand(patch)).toEqual({ seed: 1 });
  });
});

// ---- Production conformance: kind resolution inside action-style dispatch ----

describe('execute-style dispatch kind resolution', () => {
  // An 'execute' op has no fixed kind; the inner action name (or a trusted
  // dryRunKind context override) decides the dry-run plan.
  for (const [action, kind] of [
    ['get', 'capture'],
    ['secret:list', 'capture'],
    ['set', 'apply'],
  ] as const) {
    it(`action=${action} plans as ${kind} under dry-run`, async () => {
      const handler = vi.fn(() => 'observed');
      const actuator = defineActuator({
        id: 'exec-demo',
        ops: { execute: { kind: 'apply', handler } },
      });
      const result = await actuator.dispatch('execute', { action }, { dryRun: true });
      expect(handler).toHaveBeenCalledTimes(kind === 'capture' ? 1 : 0);
      if (kind === 'capture') {
        expect(result.output).toBe('observed');
      } else {
        expect(result.output).toMatchObject({ dry_run: true, mode: 'validate-only', kind });
      }
    });
  }

  it('lets a trusted dryRunKind context override drive the plan', async () => {
    const handler = vi.fn(() => 'observed');
    const actuator = defineActuator({
      id: 'exec-demo',
      ops: { execute: { kind: 'apply', handler } },
    });
    const result = await actuator.dispatch(
      'execute',
      { action: 'set' },
      { dryRun: true, dryRunKind: 'capture' }
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('observed');
  });
});

// ---- Production conformance: governed manifest effects and budgets ----

describe('governed manifest effect and budget data', () => {
  it('resolves declared effects from the real manifests and fails safe on unknown ops', () => {
    expect(resolveOpEffect('agent:list')).toBe('read');
    expect(resolveOpEffect('agent:health')).toBe('read');
    expect(resolveOpEffect('agent:a2a')).toBe('egress');
    expect(resolveOpEffect('agent:spawn')).toBe('write');
    expect(resolveOpEffect('agent:ghost')).toBe('write');
    expect(resolveOpEffect('unscoped-name')).toBe('write');
  });

  it('declares governed budgets only for registered ops', () => {
    const timeouts = loadActuatorOpRegistry().operation_timeouts_ms ?? {};
    for (const [key, ms] of Object.entries(timeouts)) {
      expect(ms, `${key} budget must be a positive integer`).toBeGreaterThan(0);
      expect(Number.isSafeInteger(ms)).toBe(true);
      const separator = key.indexOf(':');
      expect(
        determineActuatorStepType(key.slice(0, separator), key.slice(separator + 1)),
        `${key} budget names an op that is not registered`
      ).toBeTruthy();
    }
    expect(resolveActuatorOperationTimeout('system', 'exec')).toBe(120_000);
    expect(resolveActuatorOperationTimeout('system', 'shell')).toBe(120_000);
    expect(resolveActuatorOperationTimeout('agent', 'ask')).toBeUndefined();
  });
});

// ---- Production conformance: catalog input-contract completion ----

describe('catalog input-contract completion', () => {
  it('fills an undeclared schema with the open legacy contract and keeps authored schemas', () => {
    const completed = withCatalogInputContract('model', 'probe', 'apply', {
      op: 'probe',
      kind: 'apply' as const,
    });
    expect(completed.input_schema).toMatchObject({
      type: 'object',
      'x-kyberion-contract': 'inferred-legacy',
      additionalProperties: true,
    });
    const authored = { type: 'object', required: ['ref'] };
    const kept = withCatalogInputContract('model', 'probe', 'apply', {
      op: 'probe',
      kind: 'apply' as const,
      input_schema: authored,
    });
    expect(kept.input_schema).toBe(authored);
  });
});
