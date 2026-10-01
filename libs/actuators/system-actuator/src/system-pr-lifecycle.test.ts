import { describe, it, expect, vi } from 'vitest';
import { runStandardPrLifecycle, type PrLifecycleDependencies } from './system-pr-lifecycle.js';
const url = 'https://github.com/owner/repo/pull/123';
const params = {
  branch_name: 'feature/test',
  commit_message: 'feat: a $(command)',
  pr_title: 'feat: title',
  pr_body: '## Knowledge\nNone',
};
function setup(
  options: {
    files?: string;
    cached?: string;
    fail?: string;
    publishError?: boolean;
    noUrl?: boolean;
  } = {}
) {
  const exec = vi.fn((command: string, args: string[]) => {
    const key = command + ' ' + args.slice(0, 2).join(' ');
    return {
      status: key === options.fail ? 1 : 0,
      stderr: key === options.fail ? 'failed' : '',
      stdout:
        command === 'git' && args[0] === 'diff'
          ? args.includes('--cached')
            ? (options.cached ?? 'file\0')
            : (options.files ?? 'a file\0line\nbreak\0')
          : '',
    };
  });
  const write = vi.fn();
  const publish = vi.fn(async (_args: string[], print: (value: unknown) => void) => {
    if (options.publishError) throw new Error('readiness rejected');
    if (!options.noUrl) print(url);
  });
  return { exec, write, publish } as PrLifecycleDependencies & {
    exec: typeof exec;
    write: typeof write;
    publish: typeof publish;
  };
}
describe('standard PR lifecycle with fully mocked effects', () => {
  it('stages NUL-delimited paths intact and creates through governed publisher', async () => {
    const deps = setup();
    expect(await runStandardPrLifecycle(params, deps)).toEqual({ stdout: url, status: 0 });
    const adds = deps.exec.mock.calls.filter(([c, a]) => c === 'git' && a[0] === 'add');
    expect(adds.map(([, a]) => a)).toEqual([
      ['add', '--', 'a file'],
      ['add', '--', 'line\nbreak'],
    ]);
    expect(
      deps.exec.mock.calls.some(([, a]) => a[0] === 'commit' && a[2] === params.commit_message)
    ).toBe(true);
    expect(deps.write.mock.calls[0][1]).toBe(params.pr_body);
    expect(deps.publish.mock.calls[0][0]).toEqual([
      '--title',
      params.pr_title,
      '--body-file',
      expect.stringContaining('active/shared/tmp/standard-pr-lifecycle/feature%2Ftest.md'),
      '--base',
      'main',
      '--no-draft',
    ]);
    expect(deps.exec.mock.calls.some(([c]) => c === 'gh')).toBe(false);
  });
  it('skips empty commits without suppressing real commit errors', async () => {
    const empty = setup({ files: '', cached: '' });
    await runStandardPrLifecycle(params, empty);
    expect(empty.exec.mock.calls.some(([, a]) => a[0] === 'commit')).toBe(false);
    const failing = setup({ fail: 'git commit -m' });
    await expect(runStandardPrLifecycle(params, failing)).rejects.toThrow('COMMAND_FAILED');
    expect(failing.exec.mock.calls.some(([, a]) => a[0] === 'push')).toBe(false);
    expect(failing.publish).not.toHaveBeenCalled();
  });
  it('rejects reserved or option-like branch names before effects', async () => {
    for (const branch_name of ['main', '--help', '']) {
      const deps = setup();
      await expect(runStandardPrLifecycle({ ...params, branch_name }, deps)).rejects.toThrow(
        'INVALID_BRANCH'
      );
      expect(deps.exec).not.toHaveBeenCalled();
    }
  });
  it('propagates readiness rejection and missing URL without merging', async () => {
    for (const options of [{ publishError: true }, { noUrl: true }]) {
      const deps = setup(options);
      await expect(runStandardPrLifecycle({ ...params, auto_merge: true }, deps)).rejects.toThrow();
      expect(deps.exec.mock.calls.some(([c]) => c === 'gh')).toBe(false);
    }
  });
  it('fails closed on failed or pending checks before merging', async () => {
    const deps = setup({ fail: 'gh pr checks' });
    await expect(runStandardPrLifecycle({ ...params, auto_merge: true }, deps)).rejects.toThrow(
      'COMMAND_FAILED'
    );
    expect(deps.exec.mock.calls.some(([, a]) => a[1] === 'merge')).toBe(false);
  });
  it('does not sync main when the merge fails', async () => {
    const deps = setup({ fail: 'gh pr merge' });
    await expect(runStandardPrLifecycle({ ...params, auto_merge: true }, deps)).rejects.toThrow(
      'COMMAND_FAILED'
    );
    expect(deps.exec.mock.calls.some(([, a]) => a[0] === 'checkout' && a[1] === 'main')).toBe(
      false
    );
  });
  it('syncs by fast-forward only after successful explicit auto merge', async () => {
    const deps = setup();
    await runStandardPrLifecycle({ ...params, auto_merge: true }, deps);
    expect(deps.exec.mock.calls.slice(-4).map(([c, a]) => [c, a])).toEqual([
      ['gh', ['pr', 'checks', url]],
      ['gh', ['pr', 'merge', url, '--merge', '--delete-branch']],
      ['git', ['checkout', 'main']],
      ['git', ['pull', '--ff-only', 'origin', 'main']],
    ]);
  });
});
