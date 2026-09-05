import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
  },
  customerResolver: {
    activeCustomer: vi.fn(() => 'acme'),
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

vi.mock('@agent/core/customer-resolver', () => ({
  customerResolver: mocks.customerResolver,
  activeCustomer: mocks.customerResolver.activeCustomer,
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
    fs.writeFileSync(path.join(customerRoot, 'acme', 'customer.json'), '{}');
    fs.writeFileSync(path.join(customerRoot, 'acme', 'identity.json'), '{}');
    fs.writeFileSync(path.join(customerRoot, 'acme', 'vision.md'), '# vision');
    fs.writeFileSync(path.join(customerRoot, 'README.md'), 'readme');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeReaddir.mockImplementation((target: string) => fs.readdirSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));

    const mod = await import('./customer_list.js');
    expect(mod.listCustomers()).toEqual([
      { slug: 'acme', path: 'customer/acme', active: true, ready: true, missing: [] },
      {
        slug: 'client_a',
        path: 'customer/client_a',
        active: false,
        ready: false,
        missing: ['customer.json', 'identity.json', 'vision.md'],
      },
    ]);
  });

  it('returns empty list when no customer root exists', async () => {
    mocks.pathResolver.rootDir.mockReturnValue('/tmp/kyberion-missing');
    mocks.safeExistsSync.mockReturnValue(false);
    const mod = await import('./customer_list.js');
    expect(mod.listCustomers()).toEqual([]);
  });

  it('formats readiness in text mode', async () => {
    const entries = [
      { slug: 'acme', path: 'customer/acme', active: true, ready: true, missing: [] },
      {
        slug: 'client_a',
        path: 'customer/client_a',
        active: false,
        ready: false,
        missing: ['customer.json', 'vision.md'],
      },
    ];
    const mod = await import('./customer_list.js');
    const output = mod.printText(entries);

    expect(output).toEqual([
      '* acme\tready\tcustomer/acme',
      '  client_a\tmissing customer.json, vision.md\tcustomer/client_a',
    ]);
  });
});
