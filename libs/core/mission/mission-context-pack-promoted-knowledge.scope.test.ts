import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../knowledge/memory-provenance.js', async (original) => ({
  ...(await original<typeof import('../knowledge/memory-provenance.js')>()),
  resolveMemoryEligibility: () => ({ eligible: true }),
  createMemoryEligibilityResolver: () => () => ({ eligible: true }),
}));

import * as io from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { loadKnowledgeHintsIfPossible } from './mission-context-pack-knowledge.js';
import {
  findRelevantPromotedKnowledge,
  isPromotedKnowledgePath,
  promotedRecordSourceScope,
} from '../knowledge/promoted-knowledge-retrieval.js';
import type { MissionStateSummary } from './mission-context-pack-types.js';

// D8 / M1: promoted records reach a pack only when the reader scope admits them.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) io.safeRmSync(root, { recursive: true, force: true });
});

function emptySlices(): string {
  const root = pathResolver.sharedTmp('promoted-knowledge-scope-slices-' + randomUUID());
  roots.push(root);
  io.safeMkdir(root, { recursive: true });
  const file = path.join(root, 'knowledge-slices.json');
  io.safeWriteFile(file, JSON.stringify({ version: '0.5.0', slices: [] }));
  return file;
}

function mission(overrides: Partial<MissionStateSummary> = {}): MissionStateSummary {
  return {
    mission_id: 'MSN-PROMOTED-REPRO',
    mission_type: 'development',
    tier: 'public',
    status: 'active',
    assigned_persona: 'worker',
    git: { branch: 'fixture', start_commit: 'fixture', latest_commit: 'fixture', checkpoints: [] },
    history: [],
    ...overrides,
  };
}

// ─── Scoped disclosure (fixture corpus) ──────────────────────────────────────
// Fixture records are not canonical governed documents; provenance eligibility
// is exercised by the learning-delivery suites (same stance as the DA-07 suite).

const FIXTURE = pathResolver.sharedTmp(`promoted-knowledge-scope-${process.pid}`);
const PRODUCT_LESSON = 'knowledge/product/evolution/wisdom/generated/mem-FIX-ZEPHYR.md';
const PUBLIC_LESSON = 'knowledge/public/common/operations/generated/mem-FIX-ZEPHYR-PUB.md';
const TENANT_A_LESSON = 'knowledge/confidential/tenant-a/evolution/wisdom/mem-FIX-ZEPHYR-A.md';
const PERSONAL_LESSON = 'knowledge/personal/owners/abc123/wisdom/generated/mem-FIX-ZEPHYR-P.md';
const SUPERSEDED_LESSON = 'knowledge/product/evolution/wisdom/generated/mem-FIX-ZEPHYR-OLD.md';
const DISTILL_LEGACY = 'knowledge/product/evolution/distill_zephyr-ledger_2026_01_01.md';

function writeFixture(relPath: string, heading: string, extraFrontmatter = ''): void {
  const abs = path.join(FIXTURE, relPath);
  io.safeMkdir(path.dirname(abs), { recursive: true });
  io.safeWriteFile(
    abs,
    `---\nrecord_id: ${path.basename(relPath, '.md')}\nkind: knowledge_hint\n${extraFrontmatter}---\n\n# ${heading}\n\nZephyr ledger rollover must checkpoint before the quarterly close.\n`
  );
}

function writeTenantProfile(slug: string): void {
  const abs = path.join(FIXTURE, 'knowledge', 'personal', 'tenants', `${slug}.json`);
  io.safeMkdir(path.dirname(abs), { recursive: true });
  io.safeWriteFile(
    abs,
    JSON.stringify({
      tenant_slug: slug,
      display_name: `Tenant ${slug}`,
      status: 'active',
      assigned_role: 'owner',
      isolation_policy: { strict_isolation: false, allow_cross_distillation: true },
    })
  );
}

describe('promoted knowledge disclosure follows the reader scope', () => {
  beforeAll(() => {
    writeTenantProfile('tenant-a');
    writeTenantProfile('tenant-b');
    writeFixture(PRODUCT_LESSON, 'Zephyr ledger rollover lesson');
    writeFixture(PUBLIC_LESSON, 'Zephyr ledger rollover public lesson');
    writeFixture(TENANT_A_LESSON, 'Zephyr ledger rollover tenant A lesson');
    writeFixture(PERSONAL_LESSON, 'Zephyr ledger rollover personal lesson');
    writeFixture(DISTILL_LEGACY, 'Zephyr ledger rollover legacy distill');
    writeFixture(
      SUPERSEDED_LESSON,
      'Zephyr ledger rollover superseded lesson',
      'superseded_by: mem-FIX-ZEPHYR\n'
    );
  });
  afterAll(() => io.safeRmSync(FIXTURE, { recursive: true, force: true }));

  const load = (overrides: Partial<MissionStateSummary>) =>
    loadKnowledgeHintsIfPossible({
      missionState: mission({ mission_id: 'MSN-PROMOTED-SCOPE', ...overrides }),
      taskSession: { goal: { summary: 'Zephyr ledger rollover checkpoint' } } as never,
      knowledgeSlicesPath: emptySlices(),
      tenantKnowledgeRootDir: FIXTURE,
      estimatedScope: 'L',
    }).then((hints) => hints.map((hint) => hint.path));

  it('a tenantless public mission receives product and public lessons only', async () => {
    const paths = await load({});
    expect(paths).toContain(PRODUCT_LESSON);
    expect(paths).toContain(PUBLIC_LESSON);
    expect(paths).not.toContain(TENANT_A_LESSON);
    expect(paths).not.toContain(PERSONAL_LESSON);
    // The retired distill_* corpus is no longer a retrieval lane, and a
    // superseded record yields to the one that replaced it.
    expect(paths).not.toContain(DISTILL_LEGACY);
    expect(paths).not.toContain(SUPERSEDED_LESSON);
  });

  it("a tenant-b mission never receives tenant-a's lesson", async () => {
    const paths = await load({ tier: 'confidential', tenant_slug: 'tenant-b' });
    expect(paths).toContain(PRODUCT_LESSON);
    expect(paths).not.toContain(TENANT_A_LESSON);
    expect(paths).not.toContain(PERSONAL_LESSON);
  });

  it('a public mission naming tenant-a still never receives its confidential lesson', async () => {
    const paths = await load({ tenant_slug: 'tenant-a' });
    expect(paths).toContain(PRODUCT_LESSON);
    expect(paths).not.toContain(TENANT_A_LESSON);
  });

  it('a tenant-a confidential mission receives its own lesson alongside product lessons', async () => {
    const paths = await load({ tier: 'confidential', tenant_slug: 'tenant-a' });
    expect(paths).toContain(PRODUCT_LESSON);
    expect(paths).toContain(TENANT_A_LESSON);
    expect(paths).not.toContain(PERSONAL_LESSON);
  });

  it('the promoted lane admits only records the reader scope may read', async () => {
    const hits = await findRelevantPromotedKnowledge({
      topic: 'Zephyr ledger rollover',
      limit: 10,
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      rootDir: FIXTURE,
    });
    expect(hits.map((hit) => hit.path).sort()).toEqual([PRODUCT_LESSON, PUBLIC_LESSON].sort());
    expect(isPromotedKnowledgePath(TENANT_A_LESSON)).toBe(true);
    expect(isPromotedKnowledgePath(PERSONAL_LESSON)).toBe(true);
    expect(isPromotedKnowledgePath(DISTILL_LEGACY)).toBe(false);
    expect(promotedRecordSourceScope(TENANT_A_LESSON)).toEqual({
      tier: 'confidential',
      tenant_slug: 'tenant-a',
    });
  });
});
