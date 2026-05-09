import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/kyberion'),
    knowledge: vi.fn((p = '') => `/tmp/kyberion/knowledge/${String(p).replace(/^\/+/, '')}`),
  },
  createCustomer: vi.fn((slug: string) => ({ slug, root: `/tmp/kyberion/customer/${slug}`, template: '/tmp/template' })),
  safeCopyFileSync: vi.fn(),
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(),
  safeMkdir: vi.fn(),
  safeReadFile: vi.fn(),
  safeReaddir: vi.fn(),
  safeWriteFile: vi.fn(),
  classifyError: vi.fn((err: any) => ({ category: 'unknown', message: String(err?.message || err) })),
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
  safeWriteFile: mocks.safeWriteFile,
}));

vi.mock('./customer_create.js', () => ({
  createCustomer: mocks.createCustomer,
}));

describe('customer_migrate_from_personal', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates the personal identity, vision, and core overlay directories', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-migrate-'));
    const personalRoot = path.join(tmpDir, 'knowledge', 'personal');
    const customerRoot = path.join(tmpDir, 'customer', 'acme');
    fs.mkdirSync(path.join(personalRoot, 'connections'), { recursive: true });
    fs.mkdirSync(path.join(personalRoot, 'tenants'), { recursive: true });
    fs.mkdirSync(path.join(personalRoot, 'voice'), { recursive: true });
    fs.mkdirSync(customerRoot, { recursive: true });
    fs.writeFileSync(path.join(customerRoot, 'customer.json'), '{"slug":"acme","display_name":""}');
    fs.writeFileSync(path.join(personalRoot, 'my-identity.json'), '{"name":"Personal"}');
    fs.writeFileSync(path.join(personalRoot, 'my-vision.md'), '# Personal vision');
    fs.writeFileSync(path.join(personalRoot, 'connections', 'slack.json'), '{"id":"slack"}');
    fs.writeFileSync(path.join(personalRoot, 'tenants', 'default.json'), '{"tenant":"default"}');
    fs.writeFileSync(path.join(personalRoot, 'voice', 'profile-registry.json'), '{"voice":"registry"}');
    fs.writeFileSync(path.join(customerRoot, 'customer.json'), '{"slug":"acme","display_name":""}');

    mocks.pathResolver.rootDir.mockReturnValue(tmpDir);
    mocks.pathResolver.knowledge.mockImplementation((p = '') => path.join(tmpDir, 'knowledge', String(p).replace(/^\/+/, '')));
    mocks.createCustomer.mockReturnValue({ slug: 'acme', root: customerRoot, template: '/tmp/template' });
    mocks.safeExistsSync.mockImplementation((target: string) => fs.existsSync(target));
    mocks.safeLstat.mockImplementation((target: string) => fs.lstatSync(target));
    mocks.safeReaddir.mockImplementation((target: string) => fs.readdirSync(target));
    mocks.safeReadFile.mockImplementation((target: string) => fs.readFileSync(target, 'utf8'));
    mocks.safeCopyFileSync.mockImplementation((src: string, dst: string) => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    });
    mocks.safeWriteFile.mockImplementation((target: string, content: string) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    });

    const mod = await import('./customer_migrate_from_personal.js');
    const migrated = mod.migratePersonalCustomer('acme');

    expect(migrated).toBe(customerRoot);
    expect(fs.readFileSync(path.join(customerRoot, 'identity.json'), 'utf8')).toBe('{"name":"Personal"}');
    expect(fs.readFileSync(path.join(customerRoot, 'vision.md'), 'utf8')).toBe('# Personal vision');
    expect(fs.readFileSync(path.join(customerRoot, 'connections', 'slack.json'), 'utf8')).toBe('{"id":"slack"}');
    expect(fs.readFileSync(path.join(customerRoot, 'tenants', 'default.json'), 'utf8')).toBe('{"tenant":"default"}');
    expect(fs.readFileSync(path.join(customerRoot, 'voice', 'profile-registry.json'), 'utf8')).toBe('{"voice":"registry"}');
    expect(JSON.parse(fs.readFileSync(path.join(customerRoot, 'customer.json'), 'utf8')).slug).toBe('acme');
  });
});
