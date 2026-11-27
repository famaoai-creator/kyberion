import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { resolveReasoningProviderCliBinary } from '@agent/core';
import { isWindows } from '@agent/core/platform-facts';
import { resolveCodexBinary } from '@agent/core/provider/codex-cli-query';
import {
  getManagedProviderCliDefinition,
  resolveProviderCliCommand,
} from '@agent/core/provider/provider-managed-env';
import {
  listCliReasoningProviderDescriptors,
  type ReasoningProviderCli,
} from '@agent/core/reasoning/reasoning-provider-registry';
import { assertGovernedExec, buildSafeExecEnv, safeExecResultAsync } from '@agent/core/secure-io';
import { stripTerminalControl } from '../lib/tty/cli-tty-challenge-driver.js';
import { inspectCodexAccount } from './onboarding_codex_account.js';

export type AccountProvider = keyof typeof accountProbes;

export type AccountProbeFailure = 'timeout' | 'output_limit';

type AccountFields = {
  account_failure?: AccountProbeFailure;
  account_type: string | null;
  plan: string | null;
  usage?: Record<string, number | Record<string, number>>;
};

export type AccountReading = AccountFields & {
  status: 'available' | 'unavailable';
  provider: AccountProvider;
  training_use: 'unknown';
  cli_failure?: 'version_failed' | 'version_timeout' | 'probe_start_failed';
};

const TIMEOUT_MS = 10_000;
const AGY_TIER = /KYBERION-ACCOUNT-TIER:([A-Za-z][A-Za-z0-9 _+.-]{0,63});END/;

function label(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9 _+.-]{0,63}$/i.test(value.trim())
    ? value.trim()
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runAccountCli(binary: string, args: string[]) {
  return safeExecResultAsync(binary, args, {
    timeoutMs: TIMEOUT_MS,
    forceKillOnAbort: true,
    maxOutputMB: 0.25,
    cwd: tmpdir(),
  });
}

function probeFailure(error: unknown): AccountProbeFailure | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ENOBUFS') return 'output_limit';
  return undefined;
}

async function readCli(binary: string, args: string[]): Promise<string> {
  const result = await runAccountCli(binary, args);
  if (probeFailure(result.error)) throw result.error;
  return result.status === 0 ? result.stdout : '';
}

async function readTerminal<T>(
  binary: string,
  args: string[],
  inspect: (output: string, write: (input: string) => void) => T | null | undefined
): Promise<T | null> {
  assertGovernedExec(binary, args);
  const { spawn } = await import('node-pty');
  return new Promise((resolve, reject) => {
    const terminal = spawn(binary, args, {
      cwd: tmpdir(),
      env: buildSafeExecEnv({ TERM: 'xterm-256color' }),
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
    });
    let tail = '';
    let done = false;
    const finish = (value: T | null, exited = false, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try {
        if (!exited) terminal.kill(isWindows() ? undefined : 'SIGKILL');
      } catch {
        // The terminal may have exited between the last event and cleanup.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const deadline = setTimeout(
      () =>
        finish(
          null,
          false,
          Object.assign(new Error('Account terminal probe timed out'), { code: 'ETIMEDOUT' })
        ),
      TIMEOUT_MS
    );
    terminal.onExit(() => finish(null, true));
    terminal.onData((chunk) => {
      if (done) return;
      tail = (tail + chunk).slice(-16_384);
      try {
        const value = inspect(stripTerminalControl(tail), (input) => {
          tail = '';
          terminal.write(input);
        });
        if (value !== undefined) finish(value);
      } catch {
        finish(null);
      }
    });
  });
}

function readAgyTier(binary: string): Promise<string | null> {
  // Agy runs the temporary status line only inside its TUI. The command emits
  // just the requested field. No input is sent to the TUI or its trust prompts.
  const settings = {
    statusLine: {
      type: 'command',
      command:
        'jq -r \'if (.plan_tier | type == "string") then "KYBERION-ACCOUNT-TIER:" + .plan_tier + ";END" else empty end\'',
      enabled: true,
      stack_with_default: false,
    },
  };
  return readTerminal(
    binary,
    ['--settings', JSON.stringify(settings)],
    (output) => label(AGY_TIER.exec(output)?.[1]) ?? undefined
  );
}

function readGrokUsage(binary: string): Promise<Pick<AccountFields, 'plan' | 'usage'> | null> {
  let invoked = false;
  let ready = false;
  return readTerminal(binary, ['--permission-mode', 'plan'], (output, write) => {
    if (!invoked) {
      // Wait for the normal composer. Trust and authentication dialogs are
      // intentionally left unanswered.
      if (/Do you trust the contents|sign in to continue/i.test(output)) return null;
      ready ||= output.includes('Resume session');
      if (ready && output.includes('❯')) {
        invoked = true;
        write('/usage\r');
      }
      return undefined;
    }
    const limit = /Weekl?y limit \(([^)]+)\)[^%]{0,400}?(?<!\d)(\d{1,3})%/i.exec(output);
    const plan = label(limit?.[1]);
    const used = Number(limit?.[2]);
    return plan && used <= 100 ? { plan, usage: { weekly: { used_percent: used } } } : undefined;
  });
}

const GROK_COUNTERS =
  /^(?:used|limit|remaining|percent_?used|used_?percent|remaining_?percent|reset_?at|resets_?at|window_?seconds|credits_?(?:used|remaining|limit))$/i;
const GROK_WINDOWS = /^(?:usage|primary|secondary|daily|weekly|monthly|session|rate_?limit)$/i;

function grokCounters(data: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(data).filter(
      (entry): entry is [string, number] =>
        GROK_COUNTERS.test(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
}

function grokUsage(data: Record<string, unknown>): AccountFields['usage'] {
  const windows = Object.entries(data)
    .filter(([key]) => GROK_WINDOWS.test(key))
    .map(([key, value]) => [key, grokCounters(record(value))] as const)
    .filter(([, values]) => Object.keys(values).length > 0);
  const usage = { ...grokCounters(data), ...Object.fromEntries(windows) };
  return Object.keys(usage).length ? usage : undefined;
}

type AccountProbeOptions = { requirePlan?: boolean };
type AccountProbeResult = Partial<AccountFields & Pick<AccountReading, 'status'>>;

type AccountProbe = {
  resolveBinary?: () => string;
  planUnavailableHint?: string;
  inspect(binary: string, options: AccountProbeOptions): Promise<AccountProbeResult | null>;
};

const accountProbes = {
  codex: {
    resolveBinary: resolveCodexBinary,
    async inspect(binary) {
      const { status, account_type, plan, account_failure } = await inspectCodexAccount(binary);
      return { status, account_type, plan, ...(account_failure ? { account_failure } : {}) };
    },
  },
  claude: {
    async inspect(binary) {
      const data = record(JSON.parse(await readCli(binary, ['auth', 'status', '--json'])));
      return data.loggedIn === true
        ? { account_type: label(data.authMethod), plan: label(data.subscriptionType) }
        : null;
    },
  },
  agy: {
    async inspect(binary) {
      const plan = await readAgyTier(binary);
      return plan ? { plan } : null;
    },
  },
  grok: {
    planUnavailableHint:
      'Check Grok login and use an already trusted temporary directory for /usage.',
    async inspect(binary, { requirePlan }) {
      const output = await readCli(binary, ['usage', '--json']);
      let usage: AccountFields['usage'];
      try {
        usage = grokUsage(record(JSON.parse(output)));
      } catch {
        // Older builds can print a diagnostic instead of JSON.
      }
      if (usage && !requirePlan) return { usage };
      try {
        const reading = await readGrokUsage(binary);
        if (reading) return { ...reading, usage: usage ?? reading.usage };
      } catch (error) {
        if (!usage) throw error;
        const account_failure = probeFailure(error);
        return { usage, ...(account_failure ? { account_failure } : {}) };
      }
      return usage ? { usage } : null;
    },
  },
  devin: {
    async inspect(binary) {
      const output = await readCli(binary, ['auth', 'status', '--process-model', 'in-process']);
      if (!/^Logged in\b/m.test(output)) return null;
      const plan =
        label(/^\s*Tier:[ \t]*([^\r\n]+)/im.exec(output)?.[1]) ??
        label(/^\s*Plan:[ \t]*([^\r\n]+)/im.exec(output)?.[1]);
      return plan ? { plan } : null;
    },
  },
  cursor: {
    async inspect(binary) {
      const data = record(JSON.parse(await readCli(binary, ['about', '--format', 'json'])));
      const plan = label(data.subscriptionTier);
      return plan ? { plan } : null;
    },
  },
} satisfies Record<string, AccountProbe>;

export const ACCOUNT_PROVIDERS = Object.keys(accountProbes) as readonly AccountProvider[];

export function accountPlanUnavailableHint(provider: AccountProvider): string {
  const probe: AccountProbe = accountProbes[provider];
  return probe.planUnavailableHint ?? 'Check login and access to the CLI credential store.';
}

function accountCli(provider: AccountProvider): ReasoningProviderCli {
  const descriptors = listCliReasoningProviderDescriptors().filter(
    (descriptor) => descriptor.provider === provider && descriptor.cli.account_probe
  );
  if (descriptors.length !== 1) {
    throw new Error(`Expected one CLI descriptor for account probe '${provider}'.`);
  }
  return descriptors[0].cli;
}

function accountBinary(
  provider: AccountProvider,
  probe: AccountProbe,
  cli: ReasoningProviderCli
): string {
  const managed = getManagedProviderCliDefinition(provider);
  const matchesManaged = managed?.binary === cli.binary && managed.env_key === cli.bin_env_key;
  const command =
    probe.resolveBinary?.() ??
    (matchesManaged ? resolveProviderCliCommand(provider) : resolveReasoningProviderCliBinary(cli));
  return command.includes('/') || command.includes(sep) ? resolve(command) : command;
}

function unavailableAccount(provider: AccountProvider): AccountReading {
  return {
    status: 'unavailable',
    provider,
    account_type: null,
    plan: null,
    training_use: 'unknown',
  };
}

async function readAccount(
  provider: AccountProvider,
  probe: AccountProbe,
  options: AccountProbeOptions,
  binary?: string
): Promise<AccountReading> {
  const unavailable = unavailableAccount(provider);
  try {
    const command = binary ?? accountBinary(provider, probe, accountCli(provider));
    const result = await probe.inspect(command, options);
    return result
      ? { ...unavailable, ...result, status: result.status ?? 'available' }
      : unavailable;
  } catch (error) {
    const account_failure = probeFailure(error);
    return account_failure ? { ...unavailable, account_failure } : unavailable;
  }
}

export function inspectProviderAccount(
  provider: AccountProvider,
  options: AccountProbeOptions = {}
): Promise<AccountReading> {
  return readAccount(provider, accountProbes[provider], options);
}

export async function inspectInstalledAccount(
  provider: AccountProvider
): Promise<AccountReading | null> {
  const probe: AccountProbe = accountProbes[provider];
  try {
    const cli = accountCli(provider);
    const binary = accountBinary(provider, probe, cli);
    const version = await runAccountCli(binary, [...cli.version_args]);
    if (version.status === 0) return readAccount(provider, probe, { requirePlan: true }, binary);
    const code = (version.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    const cli_failure = code === 'ETIMEDOUT' ? 'version_timeout' : 'version_failed';
    return { ...unavailableAccount(provider), cli_failure };
  } catch {
    return { ...unavailableAccount(provider), cli_failure: 'probe_start_failed' };
  }
}
