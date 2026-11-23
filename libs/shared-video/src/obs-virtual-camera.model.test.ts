import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../../core/testing/finite-state-checker.js';
import {
  ObsVirtualCamera,
  validateObsSourceFilterRequest,
  type ObsSourceFilterRequest,
} from './obs-virtual-camera-output.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   applySourceFilter runs an ordered RPC protocol against OBS:
//   GetSourceFilterList → (kind-drift / disabled-create guards, fail closed)
//   → SetSourceFilterEnabled(false) when disabling → SetSourceFilterSettings
//   or CreateSourceFilter → SetSourceFilterEnabled(true) when enabling →
//   GetSourceFilter readback verification → success.
//   The model asserts: mutation never precedes the list read or a required
//   disable acknowledgement; a created filter is enabled only when the
//   request asked for it; a response completes a request only when its
//   requestId matches (stale/event frames are ignored); and success is
//   declared only after a readback whose world state equals the request —
//   a server that acknowledges a mutation without applying it can reach
//   'failed' but never 'done' (the readback gate is load-bearing).
//
// Abstraction: each pending RPC sees response ∈ {stale, fail, ok}; mutation
// ok's branch into applied/ignored to model a dishonest acknowledgement.
// The OBS world is reduced to {exists, enabled, settings-applied, kind-ok}.
// Real WebSocket framing, the Hello/Identify handshake, wall-clock timeouts,
// and settings payload contents are outside the model.

type RpcStep = 'list' | 'pre_disable' | 'mutate' | 'post_enable' | 'readback' | 'done' | 'failed';

interface FilterConfig {
  /** request.enabled after validation (default true). */
  enabled: boolean;
  /** OBS already holds a filter with this name. */
  exists: boolean;
  /** The existing filter's kind equals the request kind. */
  kindMatch: boolean;
}

interface FilterState {
  step: RpcStep;
  /** Requests that received a matching response. */
  completed: number;
  /** Responses whose requestId matched a pending request. */
  matched: number;
  listAcked: boolean;
  disableAcked: boolean;
  mutateAcked: boolean;
  enableAcked: boolean;
  readbackAcked: boolean;
  // OBS-side world (what the readback will honestly report).
  obsExists: boolean;
  obsEnabled: boolean;
  obsSettings: boolean;
  obsKindOk: boolean;
}

function filterInitial(cfg: FilterConfig): FilterState {
  return {
    step: 'list',
    completed: 0,
    matched: 0,
    listAcked: false,
    disableAcked: false,
    mutateAcked: false,
    enableAcked: false,
    readbackAcked: false,
    obsExists: cfg.exists,
    // An existing filter starts live: the dangerous case for reconfiguration.
    obsEnabled: cfg.exists,
    obsSettings: false,
    obsKindOk: cfg.exists && cfg.kindMatch,
  };
}

/** The readback gate: OBS confirms the requested state iff the world matches. */
function worldMatchesRequest(cfg: FilterConfig, s: FilterState): boolean {
  return s.obsExists && s.obsEnabled === cfg.enabled && s.obsSettings && s.obsKindOk;
}

function answered(s: FilterState, step: RpcStep, patch: Partial<FilterState>): FilterState {
  return { ...s, step, completed: s.completed + 1, matched: s.matched + 1, ...patch };
}

function filterNext(cfg: FilterConfig) {
  return (s: FilterState): ModelStep<FilterState>[] => {
    if (s.step === 'done' || s.step === 'failed') return [];
    const out: ModelStep<FilterState>[] = [];
    // A stale frame (mismatched requestId, an event op) is ignored: the
    // pending request remains pending. Self-loop — BFS dedups by state key.
    out.push({ action: `${s.step}:stale`, state: s });
    // OBS rejects the request: the operation aborts, fail closed.
    out.push({
      action: `${s.step}:fail`,
      state: answered(s, 'failed', {}),
    });
    switch (s.step) {
      case 'list': {
        // Guards run on the client after the list read, before any mutation.
        if (cfg.exists && !cfg.kindMatch) {
          out.push({
            action: 'list:ok:kind-drift',
            state: answered(s, 'failed', { listAcked: true }),
          });
        } else if (!cfg.exists && !cfg.enabled) {
          out.push({
            action: 'list:ok:disabled-create',
            state: answered(s, 'failed', { listAcked: true }),
          });
        } else {
          out.push({
            action: 'list:ok',
            state: answered(s, cfg.enabled ? 'mutate' : 'pre_disable', { listAcked: true }),
          });
        }
        break;
      }
      case 'pre_disable': {
        out.push({
          action: 'pre_disable:ok:applied',
          state: answered(s, 'mutate', { disableAcked: true, obsEnabled: false }),
        });
        out.push({
          action: 'pre_disable:ok:ignored',
          state: answered(s, 'mutate', { disableAcked: true }),
        });
        break;
      }
      case 'mutate': {
        const nextStep = cfg.enabled ? 'post_enable' : 'readback';
        const applied: Partial<FilterState> = cfg.exists
          ? { obsSettings: true }
          : // OBS always creates filters enabled; the client guards above.
            { obsExists: true, obsEnabled: true, obsSettings: true, obsKindOk: true };
        out.push({
          action: cfg.exists ? 'mutate:ok:applied' : 'create:ok:applied',
          state: answered(s, nextStep, { mutateAcked: true, ...applied }),
        });
        out.push({
          action: cfg.exists ? 'mutate:ok:ignored' : 'create:ok:ignored',
          state: answered(s, nextStep, { mutateAcked: true }),
        });
        break;
      }
      case 'post_enable': {
        out.push({
          action: 'post_enable:ok:applied',
          state: answered(s, 'readback', { enableAcked: true, obsEnabled: true }),
        });
        out.push({
          action: 'post_enable:ok:ignored',
          state: answered(s, 'readback', { enableAcked: true }),
        });
        break;
      }
      case 'readback': {
        const matches = worldMatchesRequest(cfg, s);
        out.push({
          action: matches ? 'readback:match' : 'readback:mismatch',
          state: answered(s, matches ? 'done' : 'failed', { readbackAcked: true }),
        });
        break;
      }
    }
    return out;
  };
}

function filterInvariants(cfg: FilterConfig) {
  return {
    'requests complete only on matching responses': (s: FilterState) => s.completed === s.matched,
    'no mutation before the filter list read': (s: FilterState) => !s.mutateAcked || s.listAcked,
    'kind drift never mutates': (s: FilterState) => !s.mutateAcked || !cfg.exists || cfg.kindMatch,
    'a needed disable is acknowledged before settings mutate': (s: FilterState) =>
      cfg.enabled || !s.mutateAcked || s.disableAcked,
    'a created filter is enabled only when requested': (s: FilterState) =>
      cfg.exists || !s.obsExists || !s.obsEnabled || cfg.enabled,
    'success requires a readback-verified world': (s: FilterState) =>
      s.step !== 'done' || (s.readbackAcked && worldMatchesRequest(cfg, s)),
  };
}

function filterModel(cfg: FilterConfig): SafetyModel<FilterState> {
  return {
    initial: [filterInitial(cfg)],
    key: (s) =>
      [
        s.step,
        s.completed,
        s.matched,
        s.listAcked,
        s.disableAcked,
        s.mutateAcked,
        s.enableAcked,
        s.readbackAcked,
        s.obsExists,
        s.obsEnabled,
        s.obsSettings,
        s.obsKindOk,
      ].join('|'),
    next: filterNext(cfg),
    invariants: filterInvariants(cfg),
  };
}

const FILTER_CONFIGS: Array<{
  name: string;
  cfg: FilterConfig;
  visited: number;
  transitions: number;
}> = [
  {
    name: 'create + enable',
    cfg: { enabled: true, exists: false, kindMatch: false },
    visited: 17,
    transitions: 24,
  },
  {
    name: 'update + enable',
    cfg: { enabled: true, exists: true, kindMatch: true },
    visited: 14,
    transitions: 21,
  },
  {
    name: 'update + disable',
    cfg: { enabled: false, exists: true, kindMatch: true },
    visited: 20,
    transitions: 27,
  },
  {
    name: 'kind drift refuses',
    cfg: { enabled: true, exists: true, kindMatch: false },
    visited: 3,
    transitions: 3,
  },
  {
    name: 'disable drift refuses',
    cfg: { enabled: false, exists: true, kindMatch: false },
    visited: 3,
    transitions: 3,
  },
  {
    name: 'disabled create refuses',
    cfg: { enabled: false, exists: false, kindMatch: false },
    visited: 3,
    transitions: 3,
  },
];

describe('applySourceFilter finite-state specification', () => {
  for (const { name, cfg, visited, transitions } of FILTER_CONFIGS) {
    it(`exhausts the protocol for ${name} without a safety violation`, () => {
      const result = checkFiniteStateSafety(filterModel(cfg));
      expect(result).toEqual({ status: 'verified', visited, transitions });
    });
  }

  it('detects a mutation that accepts a stale response', () => {
    const cfg: FilterConfig = { enabled: true, exists: true, kindMatch: true };
    const next = filterNext(cfg);
    const result = checkFiniteStateSafety({
      ...filterModel(cfg),
      next: (s) =>
        next(s).map((step) =>
          // Mutant: a stale frame completes the pending request.
          step.action.endsWith(':stale')
            ? { ...step, state: { ...step.state, completed: s.completed + 1 } }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('requests complete only on matching responses');
  });

  it('detects settings mutation before the disable acknowledges', () => {
    const cfg: FilterConfig = { enabled: false, exists: true, kindMatch: true };
    const next = filterNext(cfg);
    const result = checkFiniteStateSafety({
      ...filterModel(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: fire the settings mutation while the disable is pending.
        if (s.step === 'pre_disable') {
          out.push({
            action: 'mutant:mutate-before-disable',
            state: answered(s, 'readback', { mutateAcked: true, obsSettings: true }),
          });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a needed disable is acknowledged before settings mutate');
  });

  it('detects a mutation that skips readback verification', () => {
    const cfg: FilterConfig = { enabled: true, exists: true, kindMatch: true };
    const next = filterNext(cfg);
    const result = checkFiniteStateSafety({
      ...filterModel(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: declare success after enabling, before any readback.
        if (s.step === 'post_enable') {
          out.push({
            action: 'mutant:done-without-readback',
            state: { ...s, step: 'done', enableAcked: true, obsEnabled: true },
          });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('success requires a readback-verified world');
  });

  it('detects a mutation that allows a disabled create', () => {
    const cfg: FilterConfig = { enabled: false, exists: false, kindMatch: false };
    const next = filterNext(cfg);
    const result = checkFiniteStateSafety({
      ...filterModel(cfg),
      next: (s) =>
        next(s).map((step) =>
          // Mutant: no DISABLED_CREATE guard — OBS creates the filter enabled.
          step.action === 'list:ok:disabled-create'
            ? {
                action: 'mutant:create-anyway',
                state: answered(s, 'readback', {
                  listAcked: true,
                  disableAcked: true,
                  mutateAcked: true,
                  obsExists: true,
                  obsEnabled: true,
                  obsSettings: true,
                  obsKindOk: true,
                }),
              }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a created filter is enabled only when requested');
  });
});

// ---------------------------------------------------------------------------
// Conformance: the production protocol matches the specification's ordering.
// Independent fake-OBS harness (same wire shape as the unit-test fixture).
// ---------------------------------------------------------------------------

interface FakeObsOptions {
  filters?: Array<{
    filterName: string;
    filterKind: string;
    filterEnabled: boolean;
    filterIndex: number;
    filterSettings: Record<string, unknown>;
  }>;
  /** ACK mutations but never apply them — the readback gate must catch it. */
  ignoreMutations?: boolean;
  rejectDisable?: boolean;
}

function startFakeObs(options: FakeObsOptions = {}): Promise<{
  port: number;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const filters = (options.filters ?? []).map((f) => ({ ...f }));
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const address = wss.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        requests,
        close: () => new Promise<void>((done) => wss.close(() => done())),
      });
    });
    wss.on('connection', (socket: any) => {
      socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
      socket.on('message', (raw: any) => {
        let parsed: any;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (parsed.op === 1) {
          socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          return;
        }
        if (parsed.op !== 6) return;
        const { requestType, requestId, requestData } = parsed.d;
        requests.push(requestType);
        if (
          options.rejectDisable &&
          requestType === 'SetSourceFilterEnabled' &&
          requestData?.filterEnabled === false
        ) {
          socket.send(
            JSON.stringify({
              op: 7,
              d: { requestType, requestId, requestStatus: { result: false, code: 500 } },
            })
          );
          return;
        }
        if (!options.ignoreMutations) {
          if (requestType === 'CreateSourceFilter')
            filters.push({
              filterName: requestData.filterName,
              filterKind: requestData.filterKind,
              filterEnabled: true,
              filterIndex: filters.length,
              filterSettings: { ...requestData.filterSettings },
            });
          const filter = filters.find((f) => f.filterName === requestData?.filterName);
          if (filter && requestType === 'SetSourceFilterSettings')
            Object.assign(filter.filterSettings, requestData.filterSettings);
          if (filter && requestType === 'SetSourceFilterEnabled')
            filter.filterEnabled = requestData.filterEnabled;
        }
        const data: Record<string, unknown> = {};
        if (requestType === 'GetSourceFilterList') data.filters = filters;
        if (requestType === 'GetSourceFilter')
          Object.assign(data, filters.find((f) => f.filterName === requestData?.filterName) ?? {});
        socket.send(
          JSON.stringify({
            op: 7,
            d: { requestType, requestId, requestStatus: { result: true }, responseData: data },
          })
        );
      });
    });
  });
}

const colorRequest: ObsSourceFilterRequest = {
  sourceName: 'Camera',
  filterName: 'Color',
  kind: 'color_filter_v2',
  settings: { saturation: -1 },
};

describe('applySourceFilter conformance', () => {
  it('create + enable runs list → create → enable → readback', async () => {
    const server = await startFakeObs();
    try {
      const result = await new ObsVirtualCamera({ port: server.port }).applySourceFilter(
        colorRequest
      );
      expect(result.filterEnabled).toBe(true);
      expect(server.requests).toEqual([
        'GetSourceFilterList',
        'CreateSourceFilter',
        'SetSourceFilterEnabled',
        'GetSourceFilter',
      ]);
    } finally {
      await server.close();
    }
  });

  it('update + disable runs list → disable → settings → readback', async () => {
    const server = await startFakeObs({
      filters: [
        {
          filterName: 'Color',
          filterKind: 'color_filter_v2',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: { saturation: 0 },
        },
      ],
    });
    try {
      const result = await new ObsVirtualCamera({ port: server.port }).applySourceFilter({
        ...colorRequest,
        enabled: false,
      });
      expect(result.filterEnabled).toBe(false);
      expect(server.requests).toEqual([
        'GetSourceFilterList',
        'SetSourceFilterEnabled',
        'SetSourceFilterSettings',
        'GetSourceFilter',
      ]);
    } finally {
      await server.close();
    }
  });

  it('a failed disable aborts before any settings mutation', async () => {
    const server = await startFakeObs({
      rejectDisable: true,
      filters: [
        {
          filterName: 'Color',
          filterKind: 'color_filter_v2',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: { saturation: 0 },
        },
      ],
    });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port }).applySourceFilter({
          ...colorRequest,
          enabled: false,
        })
      ).rejects.toThrow(/failed/);
      expect(server.requests).toEqual(['GetSourceFilterList', 'SetSourceFilterEnabled']);
    } finally {
      await server.close();
    }
  });

  it('an acknowledged-but-ignored mutation fails closed at the readback gate', async () => {
    const server = await startFakeObs({ ignoreMutations: true });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port }).applySourceFilter(colorRequest)
      ).rejects.toThrow('OBS_FILTER_UNVERIFIED');
      // The protocol still ran to completion; only the success claim is withheld.
      expect(server.requests).toEqual([
        'GetSourceFilterList',
        'CreateSourceFilter',
        'SetSourceFilterEnabled',
        'GetSourceFilter',
      ]);
    } finally {
      await server.close();
    }
  });

  it('guards refuse kind drift and disabled creation before any mutation', async () => {
    const server = await startFakeObs({
      filters: [
        {
          filterName: 'Effect',
          filterKind: 'crop_filter',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: {},
        },
      ],
    });
    try {
      const camera = new ObsVirtualCamera({ port: server.port });
      await expect(
        camera.applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Effect',
          kind: 'color_filter_v2',
          settings: {},
        })
      ).rejects.toThrow('OBS_FILTER_KIND_DRIFT');
      await expect(
        camera.applySourceFilter({
          sourceName: 'Camera',
          filterName: 'New',
          kind: 'crop_filter',
          settings: {},
          enabled: false,
        })
      ).rejects.toThrow('OBS_FILTER_DISABLED_CREATE');
      expect(server.requests).toEqual(['GetSourceFilterList', 'GetSourceFilterList']);
    } finally {
      await server.close();
    }
  });

  it('validation defaults enabled to true and freezes the admitted snapshot', () => {
    const snapshot = validateObsSourceFilterRequest(colorRequest);
    expect(snapshot.enabled).toBe(true);
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
    expect(() =>
      validateObsSourceFilterRequest({ ...colorRequest, extra: 1 } as ObsSourceFilterRequest)
    ).toThrow('OBS_FILTER_INVALID');
  });
});
