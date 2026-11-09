import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
    shared: vi.fn((p = '') => `/tmp/kyberion/active/shared/${String(p).replace(/^\/+/, '')}`),
    knowledge: vi.fn((p = '') => `/tmp/kyberion/knowledge/${String(p).replace(/^\/+/, '')}`),
  },
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  assertSafeRepositoryPath: vi.fn((target: string) => target),
  safeMkdir: vi.fn(),
  readJson: vi.fn(),
  safeWriteFile: vi.fn(),
  listTenantProfileSlugs: vi.fn(() => [] as string[]),
  readTenantProfile: vi.fn((_slug: string) => null as { status: string } | null),
  classifyError: vi.fn((err: any) => ({
    category: 'unknown',
    message: String(err?.message || err),
  })),
  formatClassification: vi.fn((c: any) => JSON.stringify(c)),
}));

vi.mock('@agent/core', () => ({
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
  pathResolver: mocks.pathResolver,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeWriteFile: mocks.safeWriteFile,
}));

vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  // Authority loads the tracked tenant schema before per-test fixture roots apply.
  rootResolve: (await importOriginal<typeof import('@agent/core/path-resolver')>()).rootResolve,
  pathResolver: mocks.pathResolver,
}));

vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeMkdir: mocks.safeMkdir,
  safeWriteFile: mocks.safeWriteFile,
}));

vi.mock('@agent/core/foundation/json', () => ({ readJson: mocks.readJson }));

vi.mock('@agent/core/tenant-registry', () => ({
  listTenantProfileSlugs: mocks.listTenantProfileSlugs,
  readTenantProfile: mocks.readTenantProfile,
}));

vi.mock('@agent/core/error-classifier', () => ({
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
}));

vi.mock('@agent/core/governance', () => ({
  withExecutionContext: async (_role: string, run: () => unknown) => await run(),
}));

describe('stance_switch', () => {
  let tmpDir = '';

  beforeEach(() => {
    mocks.safeWriteFile.mockClear();
    mocks.readJson.mockImplementation((target: string) =>
      JSON.parse(fs.readFileSync(target, 'utf8'))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes an activation env file for the selected stance', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stance-switch-'));
    const customerDir = path.join(tmpDir, 'knowledge', 'personal', 'stances', 'acme');
    const envPath = path.join(tmpDir, 'active', 'shared', 'runtime', 'stance.env');
    fs.mkdirSync(customerDir, { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'stance.json'), '{}');
    fs.writeFileSync(path.join(customerDir, 'identity.json'), '{}');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.pathResolver.shared.mockImplementation((p = '') =>
      path.join(tmpDir, 'active', 'shared', String(p).replace(/^\/+/, ''))
    );
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));
    mocks.safeMkdir.mockImplementation((target: string) =>
      fs.mkdirSync(target, { recursive: true })
    );
    mocks.safeWriteFile.mockImplementation((target: string, content: string) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    });

    const mod = await import('./stance_switch.js');
    const result = mod.switchStance('acme');

    expect(result.envPath).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('export KYBERION_STANCE=acme\n');
  });

  function fixture(stanceJson: unknown): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stance-switch-acting-'));
    const stanceDir = path.join(tmpDir, 'knowledge', 'personal', 'stances', 'fde');
    fs.mkdirSync(stanceDir, { recursive: true });
    fs.writeFileSync(path.join(stanceDir, 'stance.json'), JSON.stringify(stanceJson));
    fs.writeFileSync(path.join(stanceDir, 'identity.json'), '{}');
    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));
    mocks.safeMkdir.mockImplementation((target: string) =>
      fs.mkdirSync(target, { recursive: true })
    );
    mocks.safeWriteFile.mockImplementation((target: string, content: string) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    });
  }

  it('binds the acting-for tenant and organization when the tenant is permitted', async () => {
    fixture({
      acting_for: { tenant_slug: 'tenant-a', organization_id: 'delivery', org_role: 'pm' },
    });
    const mod = await import('./stance_switch.js');
    const result = mod.switchStance('fde', { permittedTenants: () => ['tenant-a', 'tenant-b'] });

    expect(result.stance?.selected).toEqual({
      tenantSlug: 'tenant-a',
      organizationId: 'delivery',
      orgRole: 'pm',
    });
    // STANCE_ENV_PATH is fixed at module load; read what was written there.
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      result.envPath,
      'export KYBERION_STANCE=fde\nexport KYBERION_TENANT=tenant-a\nexport KYBERION_ORGANIZATION_ID=delivery\n',
      { encoding: 'utf8' }
    );
    expect(mod.formatSwitchedStance(result)[1]).toBe(
      'Acting for tenant tenant-a, organization delivery, as pm'
    );
  });

  it('rejects a stance that acts for a tenant the operator is not permitted to serve', async () => {
    fixture({ acting_for: { tenant_slug: 'tenant-c' } });
    const mod = await import('./stance_switch.js');
    expect(() => mod.switchStance('fde', { permittedTenants: () => ['tenant-a'] })).toThrow(
      '[STANCE_NOT_PERMITTED]'
    );
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('takes permitted tenants from active tenant registry profiles by default', async () => {
    mocks.listTenantProfileSlugs.mockReturnValue(['tenant-a', 'tenant-old']);
    mocks.readTenantProfile.mockImplementation((slug: string) => ({
      status: slug === 'tenant-a' ? 'active' : 'suspended',
    }));
    const mod = await import('./stance_switch.js');
    expect(mod.permittedStanceTenants()).toEqual(['tenant-a']);
  });

  it('rejects unknown stances', async () => {
    mocks.safeExistsSync.mockReturnValue(false);
    const mod = await import('./stance_switch.js');
    expect(() => mod.switchStance('acme')).toThrow('Stance not found');
  });

  it('rejects incomplete stances with missing required files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stance-switch-missing-'));
    const customerDir = path.join(tmpDir, 'knowledge', 'personal', 'stances', 'acme');
    fs.mkdirSync(customerDir, { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'stance.json'), '{}');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));

    const mod = await import('./stance_switch.js');
    expect(() => mod.switchStance('acme')).toThrow('Stance is not ready');
  });

  it('formats activation output without writing to stdout', async () => {
    const rootDir = '/tmp/kyberion';
    mocks.pathResolver.rootDir.mockReturnValue(rootDir);
    const mod = await import('./stance_switch.js');

    expect(
      mod.formatSwitchedStance({
        slug: 'acme',
        envPath: `${rootDir}/active/shared/runtime/stance.env`,
      })
    ).toEqual([
      'Switched stance to acme',
      'Activation profile: active/shared/runtime/stance.env',
      'Source it with: source active/shared/runtime/stance.env',
    ]);
  });

  it('routes help output through the injected printer', async () => {
    const mod = await import('./stance_switch.js');
    const output: unknown[] = [];

    expect(() => mod.main(['--help'], (value) => output.push(value))).toThrow();
    expect(output).toEqual(['Usage: stance_switch <slug>']);
  });
});
