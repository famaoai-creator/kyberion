import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  checkPrKnowledgeReadiness: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExec: mocks.safeExec,
  safeReadFile: mocks.safeReadFile,
}));

vi.mock('@agent/core/knowledge/pr-knowledge-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/pr-knowledge-readiness')>()),
  checkPrKnowledgeReadiness: mocks.checkPrKnowledgeReadiness,
}));

import { main } from './pr_preflight.js';

describe('pr preflight', () => {
  beforeEach(() => vi.resetAllMocks());

  it('runs the title check and the changed-path readiness gate without touching gh', async () => {
    mocks.safeExec.mockReturnValue('');
    const output: unknown[] = [];
    await main(['--title', 'feat(check): preflight', '--base', 'main', '--check-jobs', '2'], (v) =>
      output.push(v)
    );
    expect(mocks.safeExec).toHaveBeenCalledExactlyOnceWith(
      'pnpm',
      ['check', '--', '--changed', '--base', 'origin/main', '--jobs', '2'],
      { cwd: pathResolver.rootDir(), timeoutMs: 1_800_000 }
    );
    expect(mocks.safeExec.mock.calls.some(([command]) => command === 'gh')).toBe(false);
    expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Knowledge readiness (KL-03) not checked');
  });

  it('runs the Knowledge-in-PR check when a body file is given', async () => {
    mocks.safeExec.mockReturnValue('');
    mocks.safeReadFile.mockReturnValue('## Knowledge\n- none — test\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });
    const output: unknown[] = [];
    await main(['--title', 'feat(check): preflight', '--body-file', 'body.md'], (v) =>
      output.push(v)
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'pnpm',
      ['check', '--', '--changed'],
      expect.any(Object)
    );
    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('Knowledge readiness check passed');
  });

  it('rejects a non-conventional title before running any gate', async () => {
    await expect(main(['--title', 'did stuff'])).rejects.toThrow('--title is not valid');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('prints usage for --help and rejects unknown flags without running gates', async () => {
    const output: unknown[] = [];
    await main(['--help'], (v) => output.push(v));
    expect(String(output[0])).toContain('pnpm kyberion pr preflight');
    await expect(main(['--draft'])).rejects.toMatchObject({ code: 2 });
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });
});
