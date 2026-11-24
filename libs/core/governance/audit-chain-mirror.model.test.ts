import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../testing/finite-state-checker.js';
import {
  auditChain,
  registerAuditChainIo,
  registerTenantMirrorReaderContext,
  type AuditChainIo,
} from './audit-chain.js';
import { withStoreGrant } from '../authority.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   - a tenant mirror partition is read only under the tenant-bound
//     audit_mirror_reader grant — never under the caller's identity
//   - a caller bound to another tenant never reads (or names) that
//     tenant's partition: it is counted as withheld
//   - an unbound caller verifies every partition the master names
//   - findings only ever name partitions this process actually read
//
// Abstraction: one verifyTenantMirrors run over the tenant set the master
// chain names ({a, b} here), per caller binding (unbound, bound-a, bound-b)
// and per mirror state (missing | intact | corrupt). Master-chain building,
// hash-chain integrity, and file rotation are outside the model.

type Tenant = 'a' | 'b';
const TENANTS: readonly Tenant[] = ['a', 'b'];
type Caller = 'unbound' | Tenant;
const CALLERS: readonly Caller[] = ['unbound', 'a', 'b'];
type Mirror = 'missing' | 'intact' | 'corrupt';
const MIRRORS: readonly Mirror[] = ['missing', 'intact', 'corrupt'];

const mayBind = (caller: Caller, tenant: Tenant): boolean =>
  caller === 'unbound' || caller === tenant;

interface VerifyState {
  caller: Caller;
  mirrors: Record<Tenant, Mirror>;
  /** Master-named tenants not yet visited, in iteration order. */
  pending: readonly Tenant[];
  /** Tenants whose partition was actually opened and read. */
  read: readonly Tenant[];
  /** Tenants the binding refused; counted, never read, never named. */
  withheld: readonly Tenant[];
  /** Tenants named in a verification finding. */
  findings: readonly Tenant[];
}

const specNext = (state: VerifyState): readonly ModelStep<VerifyState>[] => {
  const tenant = state.pending[0];
  if (tenant === undefined) return [];
  const rest = state.pending.slice(1);
  if (!mayBind(state.caller, tenant)) {
    return [
      {
        action: `withhold:${tenant}`,
        state: { ...state, pending: rest, withheld: [...state.withheld, tenant] },
      },
    ];
  }
  const mirror = state.mirrors[tenant];
  return [
    {
      action: `verify:${tenant}:${mirror}`,
      state: {
        ...state,
        pending: rest,
        read: [...state.read, tenant],
        findings: mirror === 'corrupt' ? [...state.findings, tenant] : state.findings,
      },
    },
  ];
};

const model: SafetyModel<VerifyState> = {
  initial: CALLERS.flatMap((caller) =>
    MIRRORS.flatMap((a) =>
      MIRRORS.map((b): VerifyState => ({
        caller,
        mirrors: { a, b },
        pending: TENANTS,
        read: [],
        withheld: [],
        findings: [],
      }))
    )
  ),
  key: (state) => JSON.stringify(state),
  next: specNext,
  invariants: {
    'a partition is read only when the caller may bind its tenant': (s) =>
      s.read.every((tenant) => mayBind(s.caller, tenant)),
    'a bound caller never reads the other tenant': (s) =>
      s.caller === 'unbound' || !s.read.some((tenant) => tenant !== s.caller),
    'withheld partitions are never read': (s) =>
      s.withheld.every((tenant) => !s.read.includes(tenant)),
    'withheld partitions are never named in findings': (s) =>
      s.withheld.every((tenant) => !s.findings.includes(tenant)),
    'findings only name partitions that were read': (s) =>
      s.findings.every((tenant) => s.read.includes(tenant)),
    'every master tenant is either read or withheld': (s) =>
      s.read.length + s.withheld.length + s.pending.length === TENANTS.length &&
      new Set([...s.read, ...s.withheld, ...s.pending]).size === TENANTS.length,
    'an unbound caller never withholds': (s) => s.caller !== 'unbound' || s.withheld.length === 0,
    'corrupt mirrors always surface as findings when readable': (s) =>
      s.read
        .filter((tenant) => s.mirrors[tenant] === 'corrupt')
        .every((tenant) => s.findings.includes(tenant)),
  },
};

describe('tenant mirror verify finite-state specification', () => {
  it('exhausts the binding lattice without a safety violation', () => {
    const result = checkFiniteStateSafety(model);
    expect(result.status).toBe('verified');
  });

  it('detects a cross-tenant read mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) => {
        const tenant = state.pending[0];
        if (tenant !== undefined && !mayBind(state.caller, tenant)) {
          return [
            {
              action: `withhold:${tenant}`,
              state: {
                ...state,
                pending: state.pending.slice(1),
                withheld: [...state.withheld, tenant],
              },
            },
            {
              action: `read-without-binding:${tenant}`,
              state: {
                ...state,
                pending: state.pending.slice(1),
                read: [...state.read, tenant],
              },
            },
          ];
        }
        return specNext(state);
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a partition is read only when the caller may bind its tenant');
  });

  it('detects a withheld-tenant finding mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) => {
        const tenant = state.pending[0];
        if (tenant !== undefined && !mayBind(state.caller, tenant)) {
          return [
            {
              action: `withhold-and-report:${tenant}`,
              state: {
                ...state,
                pending: state.pending.slice(1),
                withheld: [...state.withheld, tenant],
                findings: [...state.findings, tenant],
              },
            },
          ];
        }
        return specNext(state);
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('withheld partitions are never named in findings');
  });
});

// ---- Production conformance: verifyTenantMirrors under real grant binding ----

const TENANT_A = 'mirror-tenant-a';
const TENANT_B = 'mirror-tenant-b';
const AUDIT_FILE = 'audit-2026-01-01.jsonl';

interface FixtureScenario {
  callerTenant: string | undefined;
  mirrorA: Mirror;
  mirrorB: Mirror;
}

function auditEntry(id: string, tenantSlug: string, hash: string): Record<string, unknown> {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    agentId: 'mirror-model',
    action: 'fixture',
    operation: 'verify-model',
    previousHash: 'genesis',
    currentHash: hash,
    result: 'completed',
    tenantSlug,
  };
}

const jsonl = (entries: Record<string, unknown>[]) =>
  entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

const masterEntries = [
  auditEntry('audit-1', TENANT_A, 'h-a1'),
  auditEntry('audit-2', TENANT_B, 'h-b1'),
  auditEntry('audit-3', TENANT_A, 'h-a2'),
  auditEntry('audit-4', TENANT_B, 'h-b2'),
];

/** Mirror content for a scenario: same entries (intact), a tampered hash (corrupt), or no dir. */
function mirrorContent(tenant: string, mirror: Mirror): string | undefined {
  if (mirror === 'missing') return undefined;
  const entries = masterEntries.filter((entry) => entry.tenantSlug === tenant);
  if (mirror === 'corrupt') {
    return jsonl(entries.map((entry) => ({ ...entry, currentHash: 'tampered' })));
  }
  return jsonl(entries);
}

/**
 * A virtual audit I/O over the scenario: every path the verifier touches is
 * classified by the tenant partition it names, so a read of a partition this
 * process may not bind is visible in `accessed`.
 */
function fixtureIo(scenario: FixtureScenario): {
  io: AuditChainIo;
  accessed: Set<string>;
} {
  const accessed = new Set<string>();
  const tenantOf = (filePath: string): string | undefined => {
    const normalized = filePath.split(path.sep).join('/');
    for (const slug of [TENANT_A, TENANT_B]) {
      if (normalized.includes(`/audit-mirror/confidential/${slug}`)) return slug;
    }
    return undefined;
  };
  const mirrorFiles = new Map<string, string>();
  const contentA = mirrorContent(TENANT_A, scenario.mirrorA);
  const contentB = mirrorContent(TENANT_B, scenario.mirrorB);
  if (contentA !== undefined) mirrorFiles.set(TENANT_A, contentA);
  if (contentB !== undefined) mirrorFiles.set(TENANT_B, contentB);
  const track = (filePath: string): void => {
    const slug = tenantOf(filePath);
    if (slug) accessed.add(slug);
  };
  const io: AuditChainIo = {
    read: (filePath) => {
      track(filePath);
      const normalized = filePath.split(path.sep).join('/');
      if (normalized.endsWith(`/logs/audit/${AUDIT_FILE}`)) return jsonl(masterEntries);
      const slug = tenantOf(filePath);
      const content = slug ? mirrorFiles.get(slug) : undefined;
      if (content === undefined) throw new Error(`ENOENT ${filePath}`);
      return content;
    },
    loadJson: () => ({}),
    exists: (filePath) => {
      track(filePath);
      const normalized = filePath.split(path.sep).join('/');
      // The audit dir resolves through vitestLivePath in tests; match by suffix.
      for (const slug of mirrorFiles.keys()) {
        if (
          normalized.endsWith(`/audit-mirror/confidential/${slug}`) ||
          normalized.endsWith(`/audit-mirror/confidential/${slug}/${AUDIT_FILE}`)
        )
          return true;
      }
      if (normalized.endsWith('/audit-mirror/confidential')) return true;
      if (normalized.endsWith('/logs/audit')) return true;
      if (normalized.endsWith(AUDIT_FILE)) return normalized.includes('/logs/audit/');
      return false;
    },
    mkdir: () => {},
    readdir: (dirPath) => {
      track(dirPath);
      const normalized = dirPath.split(path.sep).join('/');
      if (normalized.endsWith('/logs/audit')) return [AUDIT_FILE];
      for (const slug of mirrorFiles.keys()) {
        if (normalized.endsWith(`/audit-mirror/confidential/${slug}`)) return [AUDIT_FILE];
      }
      return [];
    },
    append: () => {},
    assertSafePath: (filePath) => filePath,
  };
  return { io, accessed };
}

/**
 * The expected outcome of one verify run, from the spec's own transition
 * rules (independent of the implementation).
 */
function specOutcome(scenario: FixtureScenario): {
  read: string[];
  withheld: number;
  findings: string[];
  ok: boolean;
} {
  const read: string[] = [];
  let withheld = 0;
  const findings: string[] = [];
  const caller: Caller =
    scenario.callerTenant === TENANT_A ? 'a' : scenario.callerTenant === TENANT_B ? 'b' : 'unbound';
  const mirrorOf = { a: scenario.mirrorA, b: scenario.mirrorB };
  const slugOf: Record<Tenant, string> = { a: TENANT_A, b: TENANT_B };
  for (const tenant of TENANTS) {
    if (!mayBind(caller, tenant)) {
      withheld += 1;
      continue;
    }
    read.push(slugOf[tenant]);
    if (mirrorOf[tenant] === 'corrupt') findings.push(slugOf[tenant]);
  }
  return { read, withheld, findings, ok: findings.length === 0 };
}

describe('verifyTenantMirrors conformance under the real reader grant', () => {
  registerTenantMirrorReaderContext((tenantSlug, fn) =>
    withStoreGrant('audit_mirror_reader', fn, { tenantSlug })
  );

  const savedEnv = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  for (const callerTenant of [undefined, TENANT_A, TENANT_B]) {
    for (const mirrorA of MIRRORS) {
      for (const mirrorB of MIRRORS) {
        const scenario: FixtureScenario = { callerTenant, mirrorA, mirrorB };
        const label = `caller=${callerTenant ?? 'unbound'} A=${mirrorA} B=${mirrorB}`;
        it(label, () => {
          for (const key of ['KYBERION_TENANT', 'SYSTEM_ROLE']) {
            if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
          }
          delete process.env.SYSTEM_ROLE;
          if (callerTenant === undefined) delete process.env.KYBERION_TENANT;
          else process.env.KYBERION_TENANT = callerTenant;

          const { io, accessed } = fixtureIo(scenario);
          const restore = registerAuditChainIo(io);
          try {
            const report = auditChain.verifyTenantMirrors();
            const expected = specOutcome(scenario);
            expect(report.ok).toBe(expected.ok);
            expect(report.withheld ?? 0).toBe(expected.withheld);
            for (const slug of expected.findings) {
              expect(
                report.findings.some((finding) => finding.includes(slug)),
                `expected a finding naming ${slug}`
              ).toBe(true);
            }
            // The never-read invariant: no I/O touched a partition this
            // process could not bind, and nothing beyond the master and the
            // readable mirror partitions was probed.
            for (const slug of [TENANT_A, TENANT_B]) {
              const readable = expected.read.includes(slug);
              expect(
                accessed.has(slug),
                `partition ${slug} ${readable ? 'should' : 'must not'} be touched`
              ).toBe(readable);
            }
          } finally {
            restore();
          }
        });
      }
    }
  }
});
