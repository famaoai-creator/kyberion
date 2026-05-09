import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
  },
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  safeReaddir: vi.fn(),
  activeCustomer: vi.fn(() => 'acme'),
  classifyError: vi.fn((err: any) => ({ category: 'unknown', message: String(err?.message || err) })),
  formatClassification: vi.fn((c: any) => JSON.stringify(c)),
}));

vi.mock('@agent/core', () => ({
  activeCustomer: mocks.activeCustomer,
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
  pathResolver: mocks.pathResolver,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeReaddir: mocks.safeReaddir,
}));

describe('customer_list', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lists customer directories and marks the active slug', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-list-'));
    const customerRoot = path.join(tmpDir, 'customer');
    fs.mkdirSync(path.join(customerRoot, '_template'), { recursive: true });
    fs.mkdirSync(path.join(customerRoot, 'acme'), { recursive: true });
    fs.mkdirSync(path.join(customerRoot, 'client_a'), { recursive: true });
    fs.writeFileSync(path.join(customerRoot, 'README.md'), 'readme');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeReaddir.mockImplementation((target: string) => fs.readdirSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));

    const mod = await import('./customer_list.js');
    expect(mod.listCustomers()).toEqual([
      { slug: 'acme', path: 'customer/acme', active: true },
      { slug: 'client_a', path: 'customer/client_a', active: false },
    ]);
  });

  it('returns empty list when no customer root exists', async () => {
    mocks.pathResolver.rootDir.mockReturnValue('/tmp/kyberion-missing');
    mocks.safeExistsSync.mockReturnValue(false);
    const mod = await import('./customer_list.js');
    expect(mod.listCustomers()).toEqual([]);
  });
});
