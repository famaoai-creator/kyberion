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

vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  // Authority loads the tracked tenant schema before per-test fixture roots apply.
  rootResolve: (await importOriginal<typeof import('@agent/core/path-resolver')>()).rootResolve,
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

describe('stance_create', () => {
  let tmpDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('copies templates/stance into knowledge/personal/stances/<slug>', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stance-create-'));
    const template = path.join(tmpDir, 'templates', 'stance');
    const dest = path.join(tmpDir, 'knowledge', 'personal', 'stances', 'acme');
    fs.mkdirSync(path.join(template, 'connections'), { recursive: true });
    fs.mkdirSync(path.join(template, 'policy'), { recursive: true });
    fs.writeFileSync(path.join(template, 'README.md'), 'template readme');
    fs.writeFileSync(path.join(template, 'stance.json'), '{"slug":"template"}');
    fs.writeFileSync(path.join(template, 'identity.json'), '{"name":"template"}');
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

    const mod = await import('./stance_create.js');
    const created = mod.createStance('acme');

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
    const mod = await import('./stance_create.js');
    expect(() => mod.createStance('../bad')).toThrow('Invalid KYBERION_STANCE');
  });

  it('routes help output through the injected printer', async () => {
    const mod = await import('./stance_create.js');
    const output: unknown[] = [];

    expect(() => mod.main(['--help'], (value) => output.push(value))).toThrow();
    expect(output).toEqual(['Usage: stance_create <slug>']);
  });

  it('formats creation output without writing to stdout', async () => {
    mocks.pathResolver.rootDir.mockReturnValue('/tmp/kyberion');
    const mod = await import('./stance_create.js');

    expect(mod.formatCreatedStance('/tmp/kyberion/knowledge/personal/stances/acme')).toEqual([
      'Created stance at knowledge/personal/stances/acme',
    ]);
  });
});
