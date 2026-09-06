import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
    shared: vi.fn((p = '') => `/tmp/kyberion/active/shared/${String(p).replace(/^\/+/, '')}`),
  },
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  assertSafeRepositoryPath: vi.fn((target: string) => target),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
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

vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: mocks.pathResolver,
}));

vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeMkdir: mocks.safeMkdir,
  safeWriteFile: mocks.safeWriteFile,
}));

vi.mock('@agent/core/error-classifier', () => ({
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
}));

vi.mock('@agent/core/governance', () => ({
  withExecutionContext: async (_role: string, run: () => unknown) => await run(),
}));

describe('customer_switch', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes an activation env file for the selected customer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-switch-'));
    const customerDir = path.join(tmpDir, 'customer', 'acme');
    const envPath = path.join(tmpDir, 'active', 'shared', 'runtime', 'customer.env');
    fs.mkdirSync(customerDir, { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'customer.json'), '{}');
    fs.writeFileSync(path.join(customerDir, 'identity.json'), '{}');
    fs.writeFileSync(path.join(customerDir, 'vision.md'), '# vision');

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

    const mod = await import('./customer_switch.js');
    const result = mod.switchCustomer('acme');

    expect(result.envPath).toBe(envPath);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('export KYBERION_CUSTOMER=acme\n');
  });

  it('rejects unknown customers', async () => {
    mocks.safeExistsSync.mockReturnValue(false);
    const mod = await import('./customer_switch.js');
    expect(() => mod.switchCustomer('acme')).toThrow('Customer overlay not found');
  });

  it('rejects incomplete customers with missing required files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-switch-missing-'));
    const customerDir = path.join(tmpDir, 'customer', 'acme');
    fs.mkdirSync(customerDir, { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'customer.json'), '{}');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));

    const mod = await import('./customer_switch.js');
    expect(() => mod.switchCustomer('acme')).toThrow('Customer overlay is not ready');
  });

  it('formats activation output without writing to stdout', async () => {
    const rootDir = '/tmp/kyberion';
    mocks.pathResolver.rootDir.mockReturnValue(rootDir);
    const mod = await import('./customer_switch.js');

    expect(
      mod.formatSwitchedCustomer({
        slug: 'acme',
        envPath: `${rootDir}/active/shared/runtime/customer.env`,
      })
    ).toEqual([
      'Switched customer to acme',
      'Activation profile: active/shared/runtime/customer.env',
      'Source it with: source active/shared/runtime/customer.env',
    ]);
  });

  it('routes help output through the injected printer', async () => {
    const mod = await import('./customer_switch.js');
    const output: unknown[] = [];

    expect(() => mod.main(['--help'], (value) => output.push(value))).toThrow();
    expect(output).toEqual(['Usage: customer_switch <slug>']);
  });
});
