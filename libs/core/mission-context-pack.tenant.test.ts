import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import { missionDir, pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  deriveGovernancePhaseFromMissionState,
  loadKnowledgeHintsIfPossible,
  type MissionStateSummary,
} from './mission-context-pack.js';
import { provisionTaskKnowledge } from './task-knowledge-provisioning.js';
import { _resetKnowledgeSlicesCacheForTests } from './knowledge-slices.js';
import { _resetTenantKnowledgeWarningsForTests } from './tenant-knowledge-retrieval.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import {
  knowledgeDeliveryLogDir,
  loadKnowledgeUsageAggregate,
} from './src/knowledge-feedback-loop.js';
import {
  _resetProviderEgressPolicyCacheForTests,
  type ProviderEgressPolicyFile,
} from './provider-egress-gate.js';
import type { WorkItem } from './work-coordination.js';

vi.mock('./distill-knowledge-injector.js', () => ({
  findRelevantDistilledKnowledge: vi.fn(async () => []),
}));

// XP-03: checkProviderEgress emits an ops-alert on denial; mock the sink so
// this suite never writes to the shared ops-alerts store.
vi.mock('./ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

// ─── DA-07 acceptance tests ──────────────────────────────────────────────────
//
// (1) a tenant X mission's context pack carries cards from
//     knowledge/confidential/X/ through the REAL
//     loadKnowledgeHintsIfPossible / provisionTaskKnowledge path;
// (2) tenant Y's cards never appear (strict_isolation additionally drops
//     confidential/common);
// (3) a tenant-dimension slice applies pinned/exclude;
// (4) the derived phase makes phase-scoped slices apply where they previously
//     fell through to '*';
// (5) knowledge_feedback delivery telemetry records tenant-sourced docs.

const PID = process.pid;
const fixtureRoot = pathResolver.sharedTmp(`da07-mcp-tenant-${PID}`);
const kiCacheDir = pathResolver.sharedTmp(`da07-mcp-tenant-ki-cache-${PID}`);
const slicesDir = pathResolver.sharedTmp(`da07-mcp-tenant-slices-${PID}`);
const deliveryDirOverride = pathResolver.sharedTmp(`da07-mcp-tenant-delivery-${PID}`);
const usagePathOverride = pathResolver.sharedTmp(`da07-mcp-tenant-usage-${PID}/usage.json`);
const egressPolicyDir = pathResolver.sharedTmp(`da07-mcp-tenant-egress-${PID}`);
const egressPolicyPath = path.join(egressPolicyDir, 'provider-egress-policy.json');

const TENANT_DOC = 'knowledge/confidential/tenant-x/quantum-billing-runbook.md';
const TENANT_EXCLUDED_DOC = 'knowledge/confidential/tenant-x/excluded-quantum-note.md';
const COMMON_DOC = 'knowledge/confidential/common/quantum-billing-common.md';
const PINNED_DOC = 'knowledge/product/governance/working-philosophy.md';

function writeDoc(relPath: string, title: string): void {
  const abs = path.join(fixtureRoot, relPath);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(
    abs,
    [
      '---',
      `title: ${title}`,
      'tags: [quantum, billing]',
      'last_updated: 2026-07-01',
      '---',
      '',
      `${title}. Quantum billing reconciliation procedure for monthly close.`,
      '',
    ].join('\n')
  );
}

function writeTenantProfile(slug: string, strictIsolation: boolean): void {
  const abs = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants', `${slug}.json`);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(
    abs,
    JSON.stringify({
      tenant_slug: slug,
      display_name: `Tenant ${slug}`,
      status: 'active',
      assigned_role: 'owner',
      isolation_policy: { strict_isolation: strictIsolation, allow_cross_distillation: true },
    })
  );
}

function seedFixture(): void {
  writeTenantProfile('tenant-x', false);
  writeTenantProfile('tenant-strict', true);
  writeDoc(TENANT_DOC, 'Tenant X quantum billing runbook');
  writeDoc(TENANT_EXCLUDED_DOC, 'Tenant X excluded quantum billing draft');
  writeDoc(
    'knowledge/confidential/tenant-y/quantum-billing-shadow.md',
    'Tenant Y quantum billing quantum billing reconciliation reconciliation'
  );
  writeDoc(COMMON_DOC, 'Common quantum billing guidance');
  writeDoc(
    'knowledge/confidential/tenant-strict/quantum-billing-strict.md',
    'Strict tenant quantum billing note'
  );
}

function writeSlices(name: string, content: unknown): string {
  if (!safeExistsSync(slicesDir)) safeMkdir(slicesDir, { recursive: true });
  const p = `${slicesDir}/${name}`;
  safeWriteFile(p, JSON.stringify(content, null, 2));
  return p;
}

function makeMissionState(
  overrides: Partial<MissionStateSummary> & { mission_id?: string } = {}
): MissionStateSummary {
  return {
    mission_id: overrides.mission_id ?? `MSN-DA07-TENANT-${PID}`,
    mission_type: 'product_development',
    tier: 'confidential',
    status: 'active',
    execution_mode: 'local',
    priority: 3,
    confidence_score: 1,
    assigned_persona: 'worker',
    git: { branch: 'b', start_commit: 's', latest_commit: 'l', checkpoints: [] },
    history: [],
    ...overrides,
  } as MissionStateSummary;
}

function makeWorkItem(): WorkItem {
  return {
    item_id: `WIT-DA07-${PID}`,
    title: 'Quantum billing reconciliation follow-up',
    description: 'Apply the quantum billing reconciliation runbook to the monthly close.',
    status: 'ready',
    priority: 'normal',
    source: 'local',
    source_ref: `mission:MSN-DA07-TENANT-${PID}:T1`,
    project_id: `PRJ-DA07-${PID}`,
    labels: [],
    dependencies: [],
    version: 1,
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z',
  };
}

const envKeys = [
  'KYBERION_DISABLE_EMBEDDINGS',
  'KYBERION_KI_CACHE_DIR',
  'KYBERION_KNOWLEDGE_DELIVERY_DIR',
  'KYBERION_KNOWLEDGE_USAGE_PATH',
  'KYBERION_PROVIDER_EGRESS_POLICY_PATH',
  'MISSION_ROLE',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.KYBERION_DISABLE_EMBEDDINGS = '1';
  process.env.KYBERION_KI_CACHE_DIR = kiCacheDir;
  process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = deliveryDirOverride;
  process.env.KYBERION_KNOWLEDGE_USAGE_PATH = usagePathOverride;
  _resetKnowledgeSlicesCacheForTests();
  _resetTenantKnowledgeWarningsForTests();
  vi.mocked(findRelevantDistilledKnowledge).mockReset();
  vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue([]);
  seedFixture();
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of [
    fixtureRoot,
    kiCacheDir,
    slicesDir,
    deliveryDirOverride,
    path.dirname(usagePathOverride),
    egressPolicyDir,
  ]) {
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  }
  _resetProviderEgressPolicyCacheForTests();
});

describe('DA-07 (1)(2): tenant knowledge reaches the pack; other tenants never do', () => {
  it('delivers knowledge/confidential/tenant-x/ cards for a tenant-x confidential mission', async () => {
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
    });

    expect(hints.map((h) => h.path)).toContain(TENANT_DOC);
    const tenantHint = hints.find((h) => h.path === TENANT_DOC)!;
    expect(tenantHint.title).toBe('Tenant X quantum billing runbook');
    expect(tenantHint.excerpt.length).toBeGreaterThan(0);
    expect(typeof tenantHint.score).toBe('number');
  });

  it("never delivers tenant Y's cards to a tenant-x mission (isolation, regardless of scoring)", async () => {
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
    });
    expect(hints.some((h) => h.path.includes('tenant-y'))).toBe(false);
  });

  it('strict_isolation=true drops confidential/common as well', async () => {
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-strict' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
      estimatedScope: 'L',
    });
    const paths = hints.map((h) => h.path);
    expect(paths).toContain('knowledge/confidential/tenant-strict/quantum-billing-strict.md');
    expect(paths.some((p) => p.startsWith('knowledge/confidential/common/'))).toBe(false);
    expect(paths.some((p) => p.includes('tenant-x') || p.includes('tenant-y'))).toBe(false);
  });

  it('non-strict tenant also receives confidential/common cards', async () => {
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
      estimatedScope: 'L',
    });
    expect(hints.map((h) => h.path)).toContain(COMMON_DOC);
  });

  it('a public-tier mission never pulls tenant confidential knowledge (tier gate)', async () => {
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x', tier: 'public' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
    });
    expect(hints.some((h) => h.path.startsWith('knowledge/confidential/'))).toBe(false);
  });

  it('KP-01 compatibility: without tenant context the output is exactly the distill result', async () => {
    const distillResult = [
      {
        path: 'knowledge/product/architecture/a.md',
        title: 'A',
        excerpt: 'ex-a',
        tags: ['x'],
        score: 0.5,
      },
    ];
    vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue(distillResult as any);

    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState(), // no tenant_slug anywhere
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
    });

    expect(hints).toEqual(distillResult);
  });

  it('merges deterministically: score-desc with ties going to tenant docs, distill preserved', async () => {
    vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue([
      {
        path: 'knowledge/product/architecture/high.md',
        title: 'High distill',
        excerpt: 'ex',
        tags: [],
        score: 0.99,
      },
      {
        path: 'knowledge/product/architecture/low.md',
        title: 'Low distill',
        excerpt: 'ex',
        tags: [],
        score: 0.01,
      },
    ] as any);

    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: `${slicesDir}/does-not-exist.json`,
      tenantKnowledgeRootDir: fixtureRoot,
      estimatedScope: 'L',
    });

    const paths = hints.map((h) => h.path);
    // The 0.99 distill doc outranks every lexical tenant score (≤ 0.6);
    // the 0.01 distill doc is outranked by matching tenant docs.
    expect(paths[0]).toBe('knowledge/product/architecture/high.md');
    expect(paths.indexOf(TENANT_DOC)).toBeGreaterThan(0);
    expect(paths.indexOf(TENANT_DOC)).toBeLessThan(
      paths.indexOf('knowledge/product/architecture/low.md')
    );
  });
});

describe('DA-07 (3): tenant slice dimension applies pinned/exclude', () => {
  it('a tenant-matched slice pins first and excludes tenant docs by glob', async () => {
    const slicesPath = writeSlices('tenant-slice.json', {
      version: '0.2.0',
      slices: [
        {
          id: 'tenant-x-defaults',
          match: { tenant: 'tenant-x' },
          pinned: [PINNED_DOC],
          exclude: ['knowledge/confidential/tenant-x/excluded-*.md'],
        },
      ],
    });

    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: slicesPath,
      tenantKnowledgeRootDir: fixtureRoot,
      estimatedScope: 'L',
    });

    expect(hints[0].path).toBe(PINNED_DOC);
    const paths = hints.map((h) => h.path);
    expect(paths).toContain(TENANT_DOC);
    expect(paths).not.toContain(TENANT_EXCLUDED_DOC);
  });

  it('a slice matched to a different tenant does not apply', async () => {
    const slicesPath = writeSlices('other-tenant-slice.json', {
      version: '0.2.0',
      slices: [
        {
          id: 'tenant-other-defaults',
          match: { tenant: 'tenant-other' },
          pinned: [PINNED_DOC],
        },
      ],
    });

    const hints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: slicesPath,
      tenantKnowledgeRootDir: fixtureRoot,
    });

    expect(hints.some((h) => h.path === PINNED_DOC)).toBe(false);
  });
});

describe('DA-07 (4): phase sourced from mission/work-item state', () => {
  it('derives governance phases from mission status and work-item metadata', () => {
    expect(deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'planned' }))).toBe(
      'alignment'
    );
    expect(deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'active' }))).toBe(
      'execution'
    );
    expect(deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'validating' }))).toBe(
      'review'
    );
    expect(deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'paused' }))).toBe(
      'recovery'
    );
    // Work-item metadata phase wins when it is already a governance token…
    expect(
      deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'active' }), {
        ...makeWorkItem(),
        metadata: { phase: 'review' },
      })
    ).toBe('review');
    // …but free-form workflow phase ids are NOT mapped.
    expect(
      deriveGovernancePhaseFromMissionState(makeMissionState({ status: 'active' }), {
        ...makeWorkItem(),
        metadata: { phase: 'discovery-spike' },
      })
    ).toBe('execution');
  });

  it('a phase-scoped slice now applies without an explicit phase input (previously fell through to "*")', async () => {
    const slicesPath = writeSlices('phase-slice.json', {
      version: '0.2.0',
      slices: [
        {
          id: 'execution-only',
          match: { phase: 'execution' },
          pinned: [PINNED_DOC],
        },
      ],
    });

    // status 'active' derives phase 'execution' -> the slice applies.
    const executionHints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ status: 'active' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: slicesPath,
    });
    expect(executionHints[0]?.path).toBe(PINNED_DOC);

    // status 'planned' derives 'alignment' -> the execution slice must NOT apply.
    _resetKnowledgeSlicesCacheForTests();
    const alignmentHints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ status: 'planned' }),
      workItem: makeWorkItem(),
      knowledgeSlicesPath: slicesPath,
    });
    expect(alignmentHints.some((h) => h.path === PINNED_DOC)).toBe(false);

    // An explicit phase input still wins over the derivation.
    _resetKnowledgeSlicesCacheForTests();
    const overriddenHints = await loadKnowledgeHintsIfPossible({
      missionState: makeMissionState({ status: 'planned' }),
      workItem: makeWorkItem(),
      phase: 'execution',
      knowledgeSlicesPath: slicesPath,
    });
    expect(overriddenHints[0]?.path).toBe(PINNED_DOC);
  });
});

describe('DA-07 (1)(5) E2E: provisionTaskKnowledge delivers and records tenant docs', () => {
  const missionId = `MSN-DA07-E2E-${PID}`;
  const missionPathReal = missionDir(missionId, 'confidential');

  beforeEach(() => {
    // The internal prune step writes a context rollup under the mission dir.
    process.env.MISSION_ROLE = 'mission_controller';
    // Deterministic egress verdict independent of the locally installed CLIs.
    const policy: ProviderEgressPolicyFile = {
      version: '1.0.0',
      providers: { claude: { egress: 'external-api' } },
      tier_policy: {
        confidential: { mode: 'approved-only', approved_providers: ['claude'] },
        personal: { mode: 'local-only-or-approved', approved_providers: [] },
      },
    };
    safeMkdir(egressPolicyDir, { recursive: true });
    safeWriteFile(egressPolicyPath, JSON.stringify(policy));
    process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = egressPolicyPath;
    _resetProviderEgressPolicyCacheForTests();
  });

  afterEach(() => {
    if (safeExistsSync(missionPathReal)) {
      safeRmSync(missionPathReal, { recursive: true, force: true });
    }
  });

  it('the pack carries the tenant card, and knowledge_feedback delivery telemetry records it', async () => {
    const deliveryScope = {
      tier: 'confidential' as const,
      tenant_slug: 'tenant-x',
      mission_id: missionId,
    };
    const result = await provisionTaskKnowledge({
      form: 'pack',
      missionId,
      tier: 'confidential',
      missionState: makeMissionState({ mission_id: missionId, tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      provider: 'claude',
      tenantKnowledgeRootDir: fixtureRoot,
    });

    // (1) the tenant card is in the pack and in the rendered text.
    expect(result.pack).not.toBeNull();
    const hintPaths = (result.pack!.knowledge_hints ?? []).map((h) => h.path);
    expect(hintPaths).toContain(TENANT_DOC);
    expect(result.text).toContain(TENANT_DOC);
    // (2) never another tenant's card.
    expect(hintPaths.some((p) => p.includes('tenant-y'))).toBe(false);

    // (5) delivery telemetry: no tier filtering drops the confidential path.
    expect(result.deliveredKnowledgeRefs.map((ref) => ref.path)).toContain(TENANT_DOC);
    const deliveryFiles = safeExistsSync(deliveryDirOverride);
    expect(deliveryFiles).toBe(true);
    const aggregate = loadKnowledgeUsageAggregate(deliveryScope);
    const entry = aggregate.find((e) => e.document_path === TENANT_DOC);
    expect(entry).toMatchObject({ delivered_count: 1 });
  });

  it('delivery log line records the tenant doc path verbatim (repo-relative, not dropped)', async () => {
    const deliveryScope = {
      tier: 'confidential' as const,
      tenant_slug: 'tenant-x',
      mission_id: missionId,
    };
    await provisionTaskKnowledge({
      form: 'pack',
      missionId,
      tier: 'confidential',
      missionState: makeMissionState({ mission_id: missionId, tenant_slug: 'tenant-x' }),
      workItem: makeWorkItem(),
      provider: 'claude',
      tenantKnowledgeRootDir: fixtureRoot,
    });

    const day = new Date().toISOString().slice(0, 10);
    const logPath = path.join(knowledgeDeliveryLogDir(deliveryScope), `delivery-${day}.jsonl`);
    expect(safeExistsSync(logPath)).toBe(true);
    const raw = safeReadFile(logPath, { encoding: 'utf8' }) as string;
    expect(raw).toContain(TENANT_DOC);
    expect(raw).toContain(missionId);
  });
});
