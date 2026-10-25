/**
 * D9 (option B): a tenant mission's lifecycle ledger events carry the
 * mission's tier and tenant, and their metadata lands in the tenant's own
 * ledger partition — never in the system ledger. Untenanted (public)
 * missions keep the system ledger.
 *
 * Hermetic: a temp KYBERION_ROOT (with a copy of knowledge/product for the
 * governance files, templates and schemas) is set BEFORE importing repo
 * modules, because path-resolver binds its root at import time. Raw fs seeds
 * and inspects the temp root (registered in tests/core-fs-exception-boundary.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real lifecycle notifies the operator; that is not what this test is about.
vi.mock('../surface/operator-notifications.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../surface/operator-notifications.js')>()),
  notifyOperator: vi.fn().mockResolvedValue(true),
  notifyOperatorWithReceiptSync: vi.fn(() => ({ status: 'suppressed' as const })),
}));
vi.mock('./mission-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-state.js')>()),
  checkPrerequisites: vi.fn(),
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TENANT = 'ledger-acme';
const suffix = randomUUID().slice(0, 8).toUpperCase();
const TENANT_MISSION = `MSN-LEDGER-TEN-${suffix}`;
const PUBLIC_MISSION = `MSN-LEDGER-PUB-${suffix}`;

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};

type Line = Record<string, unknown>;
function readLines(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

function closeOut(missionDir: string): void {
  const statePath = path.join(missionDir, 'mission-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.status = 'completed';
  state.outcome_contract = {
    outcome_id: `outcome-${state.mission_id}`,
    requested_result: 'Mission closeout complete.',
    success_criteria: ['The closeout note is saved'],
    deliverable_kind: 'markdown',
    evidence_required: true,
    expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
    verification_method: 'self_check',
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(missionDir, 'evidence'), { recursive: true });
  fs.writeFileSync(
    path.join(missionDir, 'evidence/closeout.md'),
    '# Closeout\nMission closeout complete.'
  );
  fs.writeFileSync(
    path.join(missionDir, 'NEXT_TASKS.json'),
    JSON.stringify([
      {
        task_id: 'task-1',
        status: 'completed',
        assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
        description: 'Close out the mission',
        deliverable: 'evidence/closeout.md',
        target_path: 'evidence/closeout.md',
      },
    ])
  );
}

describe('mission ledger scope (D9)', () => {
  beforeAll(async () => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-ledger-scope-')));
    fs.cpSync(path.join(REPO_ROOT, 'knowledge/product'), path.join(tmpRoot, 'knowledge/product'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    for (const key of [
      'KYBERION_ROOT',
      'MISSION_ROLE',
      'KYBERION_PERSONA',
      'KYBERION_TENANT',
      'KYBERION_AUDIT_CHAIN_KEY',
    ])
      saved[key] = process.env[key];
    process.env.KYBERION_ROOT = tmpRoot;
    // `pnpm mission ...` runs as mission_controller (mission_controller.ts sets it).
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    delete process.env.KYBERION_TENANT;
    // No env key: the chain key file is read/created by the first writer
    // (the tenant_ledger_store role in the first test).
    delete process.env.KYBERION_AUDIT_CHAIN_KEY;
    // Mission creation records the fixture root's HEAD.
    const { safeExec } = await import('../secure-io.js');
    safeExec('git', ['init', '-q'], { cwd: tmpRoot });
    safeExec(
      'git',
      [
        '-c',
        'user.email=ledger-scope@example.invalid',
        '-c',
        'user.name=ledger-scope',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { cwd: tmpRoot }
    );
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the audit chain key as the tenant ledger store role (first write is a tenant record)', async () => {
    const ledger = await import('../ledger.js');
    const keyFile = path.join(tmpRoot, 'active/shared/runtime/audit/chain-key');
    expect(fs.existsSync(keyFile)).toBe(false);
    const hash = ledger.record('KEY_FIRST', {
      tenant_slug: 'ledger-keyfirst',
      tier: 'confidential',
    });
    expect(hash).toHaveLength(64);
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.existsSync(ledger.GLOBAL_LEDGER_PATH)).toBe(false);
    expect(ledger.verifyTenantLedgerIntegrity('confidential', 'ledger-keyfirst')).toMatchObject({
      ok: true,
      total: 1,
      missingKey: false,
    });
  });

  it('records a confidential tenant mission in its own ledgers and never in the system ledger', async () => {
    const { createMission, startMission } = await import('./mission-creation.js');
    const { finishMission } = await import('./mission-lifecycle.js');
    const { transitionStatus } = await import('./mission-status.js');
    const ledger = await import('../ledger.js');
    const pathResolver = await import('../path-resolver.js');
    expect(pathResolver.rootDir()).toBe(tmpRoot);

    // Tenant (confidential) mission: create → start → finish.
    await createMission({
      id: TENANT_MISSION,
      tier: 'confidential',
      tenantSlug: TENANT,
      rootDir: tmpRoot,
    });
    const tenantDir = pathResolver.findMissionPath(TENANT_MISSION) as string;
    expect(tenantDir).toBeTruthy();
    await startMission({
      id: TENANT_MISSION,
      tier: 'confidential',
      tenantSlug: TENANT,
      rootDir: tmpRoot,
    });
    const evidenceLedger = path.join(tenantDir, 'evidence/ledger.jsonl');
    closeOut(tenantDir);
    await finishMission(TENANT_MISSION, false, {
      archiveDir: pathResolver.archivedMissionsRoot(),
      agentRuntimeEventPath: path.join(tmpRoot, 'active/shared/tmp/ledger-scope-events.jsonl'),
      getGitHash: () => 'abc123',
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    });

    // Public (untenanted) mission keeps the system ledger.
    await createMission({
      id: PUBLIC_MISSION,
      tier: 'public',
      rootDir: tmpRoot,
    });
    await startMission({ id: PUBLIC_MISSION, tier: 'public', rootDir: tmpRoot });

    const archivedTenantDir = pathResolver.findArchivedMissionDir(TENANT_MISSION);
    const detailLines = readLines(
      fs.existsSync(evidenceLedger)
        ? evidenceLedger
        : path.join(archivedTenantDir as string, 'evidence/ledger.jsonl')
    );
    const detailTypes = detailLines.map((line) => line.type);
    expect(detailTypes).toEqual(
      expect.arrayContaining(['MISSION_CREATE', 'MISSION_ACTIVATE', 'MISSION_FINISH'])
    );
    for (const line of detailLines) {
      expect(line.scope).toMatchObject({
        tier: 'confidential',
        tenant_slug: TENANT,
        mission_id: TENANT_MISSION,
        scope_kind: 'mission',
      });
    }

    const tenantLedgerFile = ledger.tenantLedgerPath('confidential', TENANT);
    expect(path.relative(tmpRoot, tenantLedgerFile).split(path.sep).join('/')).toBe(
      `active/shared/runtime/tenant-ledger/confidential/${TENANT}/ledger.jsonl`
    );
    const tenantLines = readLines(tenantLedgerFile);
    expect(tenantLines.map((line) => line.type)).toEqual(
      expect.arrayContaining([
        'MISSION_EVENT:MISSION_CREATE',
        'MISSION_EVENT:MISSION_ACTIVATE',
        'MISSION_EVENT:MISSION_FINISH',
      ])
    );
    for (const line of tenantLines) {
      expect(line.mission_id).toBe(TENANT_MISSION);
      expect(line.scope).toMatchObject({ tier: 'confidential', tenant_slug: TENANT });
      expect(line.payload).toBeUndefined();
    }
    // Every metadata entry links to a detailed entry of the mission ledger.
    const detailHashes = new Set(detailLines.map((line) => line.hash));
    for (const line of tenantLines) expect(detailHashes.has(line.detail_hash)).toBe(true);

    const systemRaw = fs.existsSync(ledger.GLOBAL_LEDGER_PATH)
      ? fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')
      : '';
    expect(systemRaw).not.toContain(TENANT);
    expect(systemRaw).not.toContain(TENANT_MISSION);
    const systemLines = readLines(ledger.GLOBAL_LEDGER_PATH);
    expect(
      systemLines.filter((line) => line.mission_id === PUBLIC_MISSION).map((line) => line.type)
    ).toEqual(
      expect.arrayContaining(['MISSION_EVENT:MISSION_CREATE', 'MISSION_EVENT:MISSION_ACTIVATE'])
    );

    // Integrity: one hash chain per file, the tenant partition included.
    const all = ledger.verifyAllLedgerIntegrity();
    expect(all.ok).toBe(true);
    expect(all.withheld).toBe(0);
    expect(all.ledgers.map((entry) => entry.tenant_slug ?? 'system')).toEqual([
      'system',
      TENANT,
      'ledger-keyfirst',
    ]);
    expect(ledger.verifyScopedIntegrity({ tier: 'confidential', tenant_slug: TENANT })).toBe(true);
    expect(ledger.verifyIntegrity(ledger.GLOBAL_LEDGER_PATH)).toBe(true);

    // Viewer-scoped reads: a filter naming the tenant reaches its partition;
    // a system filter never does.
    const tenantView = ledger.loadForScope({ tenant_slug: TENANT });
    expect(tenantView.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['MISSION_EVENT:MISSION_CREATE', 'MISSION_EVENT:MISSION_FINISH'])
    );
    expect(ledger.loadForScope({ tenant_slug: 'other-tenant' })).toHaveLength(0);
    expect(
      ledger
        .loadForScope({ scope_kind: 'system' })
        .some((entry) => entry.mission_id === TENANT_MISSION)
    ).toBe(false);
  }, 120_000);

  it('a process bound to another tenant may neither verify nor read the partition', async () => {
    const ledger = await import('../ledger.js');
    const { withExecutionContext } = await import('../authority.js');
    const bound = withExecutionContext(
      'mission_controller',
      () => ({
        all: ledger.verifyAllLedgerIntegrity(),
        view: ledger.loadForScope({ tenant_slug: TENANT }),
      }),
      undefined,
      'other-tenant'
    );
    expect(bound.all.withheld).toBe(2);
    expect(bound.all.ledgers.every((entry) => entry.tenant_slug === undefined)).toBe(true);
    expect(bound.view).toHaveLength(0);
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () => ledger.verifyTenantLedgerIntegrity('confidential', TENANT),
        undefined,
        'other-tenant'
      )
    ).toThrow(/ROLE_TENANT_SCOPE_MISMATCH/);
  });

  it('lets only the tenant ledger store role write a tenant partition, bound or not', async () => {
    const { withExecutionContext } = await import('../authority.js');
    const { safeAppendFileSync, safeWriteFile } = await import('../secure-io.js');
    const { validateWritePermission } = await import('../tier-guard.js');
    const partitionFile = path.join(
      tmpRoot,
      'active/shared/runtime/tenant-ledger/confidential',
      TENANT,
      'ledger.jsonl'
    );
    for (const role of ['slack_bridge', 'mission_controller']) {
      withExecutionContext(role, () => {
        // Unbound: neither the runtime default nor a broad role grant reaches it.
        expect(validateWritePermission(partitionFile).allowed).toBe(false);
        expect(() => safeWriteFile(partitionFile, '{}')).toThrow(/tenant store partition/);
        expect(() => safeAppendFileSync(partitionFile, '{}\n')).toThrow(/tenant store partition/);
      });
    }
    expect(
      withExecutionContext(
        'tenant_ledger_store',
        () => validateWritePermission(partitionFile).allowed,
        undefined,
        TENANT
      )
    ).toBe(true);
  });

  it('a tenant binding mismatch never throws and never half-writes into another scope', async () => {
    const ledger = await import('../ledger.js');
    const pathResolver = await import('../path-resolver.js');
    const { withExecutionContext } = await import('../authority.js');
    const publicDir = pathResolver.findMissionPath(PUBLIC_MISSION) as string;
    const evidence = path.join(publicDir, 'evidence/ledger.jsonl');
    const tenantFile = ledger.tenantLedgerPath('confidential', TENANT);
    const evidenceBefore = readLines(evidence).length;
    const systemBefore = readLines(ledger.GLOBAL_LEDGER_PATH).length;
    const tenantBefore = readLines(tenantFile).length;
    const bound = <T>(fn: () => T): T =>
      withExecutionContext('mission_controller', fn, undefined, 'other-tenant');

    // Active mission, record names a tenant this process is not bound to:
    // the detailed entry stays in the mission ledger, the metadata is skipped.
    const detailHash = bound(() =>
      ledger.record('BOUND_EVENT', { mission_id: PUBLIC_MISSION, tenant_slug: 'ledger-third' })
    );
    expect(detailHash).toHaveLength(64);
    expect(readLines(evidence)).toHaveLength(evidenceBefore + 1);
    // No mission ledger: the tenant record is skipped entirely.
    expect(
      bound(() =>
        ledger.record('BOUND_NOMISSION', { tenant_slug: 'ledger-third', tier: 'confidential' })
      )
    ).toBe('');
    // Another tenant's (archived) mission: skipped, never the system ledger.
    expect(bound(() => ledger.record('BOUND_FOREIGN', { mission_id: TENANT_MISSION }))).toBe('');

    expect(readLines(ledger.GLOBAL_LEDGER_PATH)).toHaveLength(systemBefore);
    expect(readLines(tenantFile)).toHaveLength(tenantBefore);
    expect(fs.existsSync(ledger.tenantLedgerPath('confidential', 'ledger-third'))).toBe(false);
  });

  it("the mission's location wins over a disagreeing state (tenant or tier)", async () => {
    const ledger = await import('../ledger.js');
    const tenantFile = ledger.tenantLedgerPath('confidential', TENANT);
    const seed = (id: string, state: Record<string, unknown>) => {
      const dir = path.join(tmpRoot, 'active/missions/confidential', TENANT, id);
      fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'mission-state.json'),
        JSON.stringify({ mission_id: id, status: 'active', ...state })
      );
    };
    const liar = `MSN-LEDGER-LIE-${suffix}`;
    const tierLiar = `MSN-LEDGER-TIER-${suffix}`;
    seed(liar, { tier: 'confidential', tenant_slug: 'ledger-liar' });
    seed(tierLiar, { tier: 'public', tenant_slug: TENANT });

    expect(() => ledger.record('LIE_EVENT', { mission_id: liar })).not.toThrow();
    expect(() => ledger.record('TIER_LIE_EVENT', { mission_id: tierLiar })).not.toThrow();

    expect(fs.existsSync(ledger.tenantLedgerPath('confidential', 'ledger-liar'))).toBe(false);
    const tenantIds = readLines(tenantFile).map((line) => line.mission_id);
    expect(tenantIds).not.toContain(liar);
    expect(tenantIds).not.toContain(tierLiar);
    const systemRaw = fs.existsSync(ledger.GLOBAL_LEDGER_PATH)
      ? fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')
      : '';
    expect(systemRaw).not.toContain(liar);
    expect(systemRaw).not.toContain(tierLiar);
    expect(systemRaw).not.toContain('ledger-liar');
  });

  it('a public-tier tenant mission is stored under a protected tier, keeping its public scope', async () => {
    const { createMission } = await import('./mission-creation.js');
    const ledger = await import('../ledger.js');
    const id = `MSN-LEDGER-PUBTEN-${suffix}`;
    await createMission({ id, tier: 'public', tenantSlug: TENANT, rootDir: tmpRoot });

    expect(fs.existsSync(path.join(tmpRoot, ledger.TENANT_LEDGER_ROOT, 'public'))).toBe(false);
    const entry = readLines(ledger.tenantLedgerPath('public', TENANT)).find(
      (line) => line.mission_id === id
    );
    expect(entry).toMatchObject({
      type: 'MISSION_EVENT:MISSION_CREATE',
      scope: { tier: 'public', tenant_slug: TENANT },
    });
    expect(ledger.tenantLedgerPath('public', TENANT)).toBe(
      ledger.tenantLedgerPath('confidential', TENANT)
    );
    expect(fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')).not.toContain(id);
  }, 60_000);

  it('routes an archived tenant mission to its tenant; an unknown id stays a system record', async () => {
    const ledger = await import('../ledger.js');
    ledger.record('LATE_EVENT', { mission_id: TENANT_MISSION, note: 'after archive' });
    const late = readLines(ledger.tenantLedgerPath('confidential', TENANT)).find(
      (line) => line.type === 'LATE_EVENT'
    );
    expect(late).toMatchObject({
      mission_id: TENANT_MISSION,
      scope: { tier: 'confidential', tenant_slug: TENANT },
    });
    expect(fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')).not.toContain(TENANT_MISSION);

    // Residual case (runtime-storage-layout.md, D4): an id no process can
    // place keeps its raw id in the system ledger; the payload is withheld.
    const orphan = `MSN-LEDGER-NOWHERE-${suffix}`;
    const marker = `orphan-payload-marker-${suffix}`;
    ledger.record('ORPHAN_EVENT', { mission_id: orphan, note: marker });
    const orphanEntry = readLines(ledger.GLOBAL_LEDGER_PATH).find(
      (line) => line.mission_id === orphan
    );
    expect(orphanEntry).toMatchObject({
      type: 'ORPHAN_EVENT',
      scope: { scope_kind: 'mission', mission_id: orphan },
      payload_withheld: 'mission_unplaceable',
    });
    expect(orphanEntry?.payload).toBeUndefined();
    expect(String(orphanEntry?.payload_digest)).toMatch(/^[0-9a-f]{64}$/u);
    expect(fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')).not.toContain(marker);
    expect(ledger.verifyAllLedgerIntegrity().ok).toBe(true);

    // An explicit tenant still routes an unknown id to that tenant with full detail.
    const tenantOrphan = `MSN-LEDGER-NOWHERE-TEN-${suffix}`;
    ledger.record('ORPHAN_TENANT_EVENT', {
      mission_id: tenantOrphan,
      tenant_slug: TENANT,
      tier: 'confidential',
      note: marker,
    });
    expect(
      readLines(ledger.tenantLedgerPath('confidential', TENANT)).find(
        (line) => line.mission_id === tenantOrphan
      )
    ).toMatchObject({ type: 'ORPHAN_TENANT_EVENT', payload: { note: marker } });
    expect(fs.readFileSync(ledger.GLOBAL_LEDGER_PATH, 'utf8')).not.toContain(tenantOrphan);
    expect(ledger.verifyAllLedgerIntegrity().ok).toBe(true);
  });

  it('refuses to fork a chain whose tail cannot be parsed', async () => {
    const ledger = await import('../ledger.js');
    const file = ledger.tenantLedgerPath('confidential', 'ledger-keyfirst');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, `${original}{not json\n`);
      expect(() =>
        ledger.record('AFTER_BROKEN_TAIL', { tenant_slug: 'ledger-keyfirst', tier: 'confidential' })
      ).toThrow(/LEDGER_TAIL_UNREADABLE/);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('detects tampering in a tenant partition', async () => {
    const ledger = await import('../ledger.js');
    const file = ledger.tenantLedgerPath('confidential', TENANT);
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, original.replace('MISSION_EVENT:MISSION_CREATE', 'MISSION_EVENT:X'));
      expect(ledger.verifyTenantLedgerIntegrity('confidential', TENANT).ok).toBe(false);
      expect(ledger.verifyAllLedgerIntegrity().ok).toBe(false);
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});
