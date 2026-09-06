import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
    knowledge: vi.fn((p = '') => `/tmp/kyberion/knowledge/${String(p).replace(/^\/+/, '')}`),
  },
  safeCopyFileSync: vi.fn(),
  assertSafeRepositoryPath: vi.fn((target: string) => target),
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(),
  safeReaddir: vi.fn(),
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
  safeCopyFileSync: mocks.safeCopyFileSync,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeMkdir: mocks.safeMkdir,
  safeReadFile: mocks.safeReadFile,
  safeReaddir: mocks.safeReaddir,
}));

vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: mocks.pathResolver,
}));

vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeCopyFileSync: mocks.safeCopyFileSync,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
  safeMkdir: mocks.safeMkdir,
  safeReaddir: mocks.safeReaddir,
}));

vi.mock('@agent/core/error-classifier', () => ({
  classifyError: mocks.classifyError,
  formatClassification: mocks.formatClassification,
}));

vi.mock('@agent/core/governance', () => ({
  withExecutionContext: async (_role: string, run: () => unknown) => await run(),
}));

describe('customer_create', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('copies the template tree into a new customer root', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-create-'));
    const template = path.join(tmpDir, 'customer', '_template');
    const dest = path.join(tmpDir, 'customer', 'acme');
    fs.mkdirSync(path.join(template, 'connections'), { recursive: true });
    fs.mkdirSync(path.join(template, 'policy'), { recursive: true });
    fs.writeFileSync(path.join(template, 'README.md'), 'template readme');
    fs.writeFileSync(path.join(template, 'customer.json'), '{"slug":"template"}');
    fs.writeFileSync(path.join(template, 'identity.json'), '{"name":"template"}');
    fs.writeFileSync(path.join(template, 'vision.md'), '# Vision');
    fs.writeFileSync(path.join(template, 'connections', 'slack.json'), '{"id":"slack"}');
    fs.writeFileSync(path.join(template, 'policy', 'approval.json'), '{"mode":"template"}');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeReaddir.mockImplementation((target: string) => fs.readdirSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));
    mocks.safeCopyFileSync.mockImplementation((src: string, dst: string) => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    });

    const mod = await import('./customer_create.js');
    const created = mod.createCustomer('acme');

    expect(created.root).toBe(dest);
    expect(fs.existsSync(path.join(dest, 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'connections', 'slack.json'), 'utf8')).toBe(
      '{"id":"slack"}'
    );
    expect(fs.readFileSync(path.join(dest, 'policy', 'approval.json'), 'utf8')).toBe(
      '{"mode":"template"}'
    );
  });

  it('rejects invalid slugs', async () => {
    const mod = await import('./customer_create.js');
    expect(() => mod.createCustomer('../bad')).toThrow('Invalid customer slug');
  });

  it('routes help output through the injected printer', async () => {
    const mod = await import('./customer_create.js');
    const output: unknown[] = [];

    expect(() => mod.main(['--help'], (value) => output.push(value))).toThrow();
    expect(output).toEqual(['Usage: customer_create <slug>']);
  });

  it('formats creation output without writing to stdout', async () => {
    mocks.pathResolver.rootDir.mockReturnValue('/tmp/kyberion');
    const mod = await import('./customer_create.js');

    expect(mod.formatCreatedCustomer('/tmp/kyberion/customer/acme')).toEqual([
      'Created customer template at customer/acme',
    ]);
  });
});
