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
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  classifyError: vi.fn((err: any) => ({ category: 'unknown', message: String(err?.message || err) })),
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
    mocks.pathResolver.shared.mockImplementation((p = '') => path.join(tmpDir, 'active', 'shared', String(p).replace(/^\/+/, '')));
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeMkdir.mockImplementation((target: string) => fs.mkdirSync(target, { recursive: true }));
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

    const mod = await import('./customer_switch.js');
    expect(() => mod.switchCustomer('acme')).toThrow('Customer overlay is not ready');
  });
});
