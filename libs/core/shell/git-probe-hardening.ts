import { devNull } from 'node:os';
import { safeExecResult, type SafeExecOptions } from '../secure-io.js';

const CONFIG: Array<[string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', devNull],
  ['core.untrackedCache', 'false'],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['sequence.editor', 'false'],
  ['credential.helper', ''],
  ['core.askPass', ''],
  ['diff.external', ''],
  // Missing promisor objects must not initiate an unapproved network fetch.
  ['protocol.allow', 'never'],
];

export class GitProbeUnavailableError extends Error {
  constructor(message: string) {
    super(`[GIT_PROBE_UNAVAILABLE] ${message}`);
    this.name = 'GitProbeUnavailableError';
  }
}

/** Only internal, subcommand-first, read-only probes use this boundary. */
export function hardenedGitProbeArgs(args: readonly string[]): string[] {
  const sha = (value: string | undefined) =>
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
  const exact = (...expected: string[]) =>
    args.length === expected.length && expected.every((value, index) => args[index] === value);
  const revisionProbe =
    exact('rev-parse', '--is-inside-work-tree') ||
    exact('rev-parse', '--show-toplevel') ||
    exact('rev-parse', '--git-path', 'index') ||
    exact('rev-parse', '--verify', '--quiet', 'HEAD');
  const indexProbe = exact('ls-files', '-s', '-z');
  const treeProbe =
    args.length === 4 &&
    args[0] === 'ls-tree' &&
    args[1] === '-r' &&
    args[2] === '-z' &&
    sha(args[3]);
  const treeDiff =
    args.length === 6 &&
    args[0] === 'diff-tree' &&
    args[1] === '-r' &&
    args[2] === '-z' &&
    args[3] === '--no-renames' &&
    sha(args[4]) &&
    sha(args[5]);
  // Deliberately no generic status/worktree diff: filter discovery in a prior
  // process cannot fence concurrent changes or submodule configurations.
  if (!revisionProbe && !indexProbe && !treeProbe && !treeDiff)
    throw new GitProbeUnavailableError('unsupported object/index probe grammar');
  return treeDiff ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : [...args];
}

function probeEnv(
  config: Array<[string, string]>,
  env?: SafeExecOptions['env']
): Record<string, string | undefined> {
  return {
    ...env,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ])
    ),
  };
}

/** Bounded filter discovery plus a closed object/index-only execution grammar.
 * Discovery is not an authorization or TOCTOU fence; unsupported worktree
 * operations remain unavailable even when no filters were discovered. */
export function runHardenedGitProbe(args: readonly string[], options: SafeExecOptions = {}) {
  const hardened = hardenedGitProbeArgs(args);
  const discovered = safeExecResult(
    'git',
    ['config', '--includes', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
    {
      cwd: options.cwd,
      timeoutMs: Math.min(options.timeoutMs ?? 5000, 5000),
      maxOutputMB: 1,
      env: probeEnv(CONFIG, options.env),
    }
  );
  // git config status 1 means no matching keys; every other failure is unknown.
  if (discovered.status !== 0 && discovered.status !== 1)
    throw new GitProbeUnavailableError('filter discovery failed');
  const records = discovered.stdout.split('\0').filter(Boolean);
  if (records.length > 4096) throw new GitProbeUnavailableError('filter discovery exceeded bounds');
  const config = [...CONFIG];
  for (const record of records) {
    const key = record.slice(0, record.indexOf('\n'));
    if (!/^filter\..+\.(?:clean|smudge|process)$/i.test(key))
      throw new GitProbeUnavailableError('invalid filter discovery record');
    config.push([key, ''], [key.replace(/\.(?:clean|smudge|process)$/i, '.required'), 'false']);
  }
  return safeExecResult('git', hardened, { ...options, env: probeEnv(config, options.env) });
}
