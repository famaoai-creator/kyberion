import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
  },
  customerResolver: {
    activeStance: vi.fn(() => 'acme'),
  },
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  safeReaddir: vi.fn(),
  assertSafeRepositoryPath: vi.fn((target: string) => target),
  classifyError: vi.fn((err: any) => ({
    category: 'unknown',
    message: String(err?.message || err),
  })),
  formatClassification: vi.fn((c: any) => JSON.stringify(c)),
}));

vi.mock('@agent/core/error-classifier', () => ({
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
}));

vi.mock('@agent/core/stance-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/stance-resolver')>()),
  customerResolver: mocks.customerResolver,
  activeStance: mocks.customerResolver.activeStance,
}));

vi.mock('@agent/core/path-resolver', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/path-resolver')>(
    '@agent/core/path-resolver'
  );
  return {
    ...actual,
    pathResolver: { ...actual.pathResolver, rootDir: mocks.pathResolver.rootDir },
  };
});

vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeReaddir: mocks.safeReaddir,
}));

describe('stance_list', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lists stance directories and marks the active slug', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stance-list-'));
    const stanceRoot = path.join(tmpDir, 'knowledge', 'personal', 'stances');
    fs.mkdirSync(path.join(stanceRoot, 'acme'), { recursive: true });
    fs.mkdirSync(path.join(stanceRoot, 'client_a'), { recursive: true });
    fs.writeFileSync(path.join(stanceRoot, 'acme', 'stance.json'), '{}');
    fs.writeFileSync(path.join(stanceRoot, 'acme', 'identity.json'), '{}');
    fs.writeFileSync(path.join(stanceRoot, 'README.md'), 'readme');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeReaddir.mockImplementation((target: string) => fs.readdirSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));

    const mod = await import('./stance_list.js');
    expect(mod.listStances()).toEqual([
      {
        slug: 'acme',
        path: 'knowledge/personal/stances/acme',
        active: true,
        ready: true,
        missing: [],
      },
      {
        slug: 'client_a',
        path: 'knowledge/personal/stances/client_a',
        active: false,
        ready: false,
        missing: ['stance.json', 'identity.json'],
      },
    ]);
  });

  it('returns empty list when no stances directory exists', async () => {
    mocks.pathResolver.rootDir.mockReturnValue('/tmp/kyberion-missing');
    mocks.safeExistsSync.mockReturnValue(false);
    const mod = await import('./stance_list.js');
    expect(mod.listStances()).toEqual([]);
  });

  it('formats readiness in text mode', async () => {
    const entries = [
      {
        slug: 'acme',
        path: 'knowledge/personal/stances/acme',
        active: true,
        ready: true,
        missing: [],
      },
      {
        slug: 'client_a',
        path: 'knowledge/personal/stances/client_a',
        active: false,
        ready: false,
        missing: ['stance.json'],
      },
    ];
    const mod = await import('./stance_list.js');
    const output = mod.printText(entries);

    expect(output).toEqual([
      '* acme\tready\tknowledge/personal/stances/acme',
      '  client_a\tmissing stance.json\tknowledge/personal/stances/client_a',
    ]);
  });
});
