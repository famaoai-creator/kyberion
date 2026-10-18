/* eslint-disable no-restricted-imports -- isolated child needs an exact minimal env; safeSpawn's buildSafeExecEnv would add MISSION_ROLE/KYBERION_* (gated via assertGovernedExec + withWallClockBudget instead) */
/**
 * Codex Isolated Query — one-shot structured-output generation through the
 * local `codex` CLI for UNTRUSTED prompts (e.g. peer conversation auto
 * replies), with no usable tools and no execution / write authority.
 *
 * Isolation model (verified against codex-cli 0.163 by an isolation probe):
 *   - {@link CODEX_ISOLATED_EXEC_FLAGS}: no user config / rules / session
 *     persistence, read-only sandbox, approvals never, web search off, no MCP
 *     servers, and every tool-bearing feature disabled.
 *   - cwd = a fresh, empty governed scratch workspace (removed afterwards);
 *     env = PATH, HOME, USER, LANG, TMPDIR (+ CODEX_HOME) only — never
 *     KYBERION_* / MISSION_* / other provider keys.
 *   - The model still SEES some tool definitions (exec, apply_patch,
 *     spawn_agent, MCP resource readers, …); attempts fail closed inside the
 *     CLI (`codex_core::tools::router` errors). Because that is not a
 *     guarantee across versions, the CLI version is gated
 *     ({@link TESTED_CODEX_CLI_VERSIONS}) and any observed tool attempt
 *     discards the output ({@link detectCodexToolAttempt}).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { z, type ZodType } from 'zod';
import { logger } from '../core.js';
import { metrics } from '../metrics.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { assertGovernedExec, safeWriteFile } from '../secure-io.js';
import {
  createScratchWorkspace,
  deleteRegisteredWorkspace,
} from '../workforce/workspace-ledger.js';
import { assertReasoningEgressAllowed } from '../reasoning/reasoning-egress-scope.js';
import {
  delegationChildHandleFromChildProcess,
  withWallClockBudget,
  DelegationWallClockExceededError,
} from '../mission/delegation-concurrency.js';
import { normalizeCodexSchema, resolveCodexBinary } from './codex-cli-query.js';

/** codex-cli `major.minor` versions the isolation probe has verified. */
export const TESTED_CODEX_CLI_VERSIONS: readonly string[] = ['0.163'];

/**
 * `codex exec` flags for an isolated, tool-less run (codex-cli 0.163). Order
 * matters only for readability. `include_apply_patch_tool` is intentionally
 * absent: 0.163 does not recognize that config key.
 */
export const CODEX_ISOLATED_EXEC_FLAGS: readonly string[] = [
  // Ignore ~/.codex/config.toml, execpolicy rules and session persistence.
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--skip-git-repo-check',
  // Read-only sandbox, never ask for approval, no web search, no MCP servers.
  '-s',
  'read-only',
  '-c',
  'approval_policy=never',
  '-c',
  'web_search=disabled',
  '-c',
  'mcp_servers={}',
  // Every tool-bearing feature off.
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'unified_exec_tty',
  '--disable',
  'apps',
  '--disable',
  'plugins',
  '--disable',
  'hooks',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'in_app_browser',
  '--disable',
  'computer_use',
  '--disable',
  'view_image',
  '--disable',
  'code_mode_host',
  '--disable',
  'code_mode_interrupt',
  '--disable',
  'skill_search',
  '--disable',
  'tool_suggest',
  '--disable',
  'sleep_tool',
  '--disable',
  'goals',
  '--disable',
  'skill_mcp_dependency_install',
  '--disable',
  'multi_agent',
  '--disable',
  'image_generation',
  '--disable',
  'realtime_conversation',
  '--disable',
  'collaboration_modes',
];

/** The only env keys the isolated child receives (when set). */
export const CODEX_ISOLATED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'CODEX_HOME',
];

/** stderr lines that indicate the model tried to use a tool. */
export const CODEX_TOOL_ATTEMPT_STDERR_PATTERN =
  /tools::router|tool call|exec_command|apply_patch|spawn_agent|mcp_tool/i;

/** `--json` item types a tool-less run may produce. */
const ALLOWED_ITEM_TYPES = new Set(['agent_message', 'reasoning']);
/** The benign error item every run emits because code mode is disabled. */
const BENIGN_CODE_MODE_ERROR = /^Code Mode is unavailable because code-mode host is disabled/;
/** Top-level `--json` event types; anything else fails closed. */
const KNOWN_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

const VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCHEMA_FILE = 'output-schema.json';

export type CodexIsolatedQueryErrorCode =
  | 'CODEX_TOOL_ATTEMPT'
  | 'CODEX_ISOLATION_UNTESTED'
  | 'CODEX_EXEC_FAILED'
  | 'CODEX_NO_RESULT'
  | 'CODEX_PARSE_FAILED'
  | 'CODEX_TIMEOUT';

export class CodexIsolatedQueryError extends Error {
  constructor(
    message: string,
    readonly code: CodexIsolatedQueryErrorCode,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = 'CodexIsolatedQueryError';
  }
}

export interface RunCodexIsolatedQueryParams<T> {
  systemPrompt: string;
  /** Caller-framed prompt; untrusted sections must already be framed. */
  userPrompt: string;
  schema: ZodType<T>;
  abortController?: AbortController;
  /** Wall-clock budget for the generation run. Default 120s. */
  timeoutMs?: number;
  /** Metrics component label. Default 'reasoning:codex-isolated'. */
  metricsLabel?: string;
  /** Run on a codex-cli version the isolation probe has not verified. */
  allowUntestedVersion?: boolean;
  /** Explicit codex binary (default: {@link resolveCodexBinary}). */
  bin?: string;
}

export interface CodexIsolatedQueryResult<T> {
  parsed: T;
  /** Parsed `--json` events, for traceability. */
  rawEvents?: unknown[];
}

interface ChildRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Minimal env for the isolated child: {@link CODEX_ISOLATED_ENV_KEYS} only. */
export function buildCodexIsolatedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CODEX_ISOLATED_ENV_KEYS) {
    const value = baseEnv[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return env;
}

/** `codex-cli 0.163.0` → `0.163`; undefined when no version is found. */
export function parseCodexCliMajorMinor(versionOutput: string): string | undefined {
  // Linear scan: bounded input, whitespace tokens, bounded digit runs (no
  // backtracking on long digit strings from untrusted CLI output).
  for (const token of versionOutput.slice(0, 256).split(/\s+/)) {
    const match = /^v?(\d{1,6})\.(\d{1,6})(?:\.\d{1,6})?$/.exec(token);
    if (match) return `${match[1]}.${match[2]}`;
  }
  return undefined;
}

/**
 * Fail-closed tool-attempt detector. Returns evidence when stderr carries a
 * tool-router / tool-call line, or when a `--json` event is anything other
 * than lifecycle, `agent_message`, `reasoning` or the benign code-mode error.
 */
export function detectCodexToolAttempt(input: {
  stderr: string;
  events: unknown[];
}): string | undefined {
  const line = input.stderr
    .split(/\r?\n/)
    .find((candidate) => CODEX_TOOL_ATTEMPT_STDERR_PATTERN.test(candidate));
  if (line) return `stderr: ${line.trim().slice(0, 300)}`;
  for (const event of input.events) {
    const record = asRecord(event);
    const type = typeof record?.type === 'string' ? record.type : '<missing>';
    if (!KNOWN_EVENT_TYPES.has(type)) return `event type ${type}`;
    if (!type.startsWith('item.')) continue;
    const item = asRecord(record?.item);
    const itemType = typeof item?.type === 'string' ? item.type : '<missing>';
    if (ALLOWED_ITEM_TYPES.has(itemType)) continue;
    if (
      itemType === 'error' &&
      typeof item?.message === 'string' &&
      BENIGN_CODE_MODE_ERROR.test(item.message)
    ) {
      continue;
    }
    return `${type} item type ${itemType}`;
  }
  return undefined;
}

/**
 * Run a one-shot structured query through an isolated `codex exec`. Throws
 * {@link CodexIsolatedQueryError}; `CODEX_TOOL_ATTEMPT` means the output was
 * discarded because the model tried to use a tool.
 */
export async function runCodexIsolatedQuery<T>(
  params: RunCodexIsolatedQueryParams<T>
): Promise<CodexIsolatedQueryResult<T>> {
  assertReasoningEgressAllowed('codex-cli');
  const bin = params.bin ?? resolveCodexBinary();
  const env = buildCodexIsolatedEnv();
  const signal = params.abortController?.signal;
  const workspace = createScratchWorkspace({});
  const startedAt = Date.now();
  let status: 'success' | 'error' = 'error';
  let usage: Record<string, number> | undefined;
  try {
    await assertTestedCodexVersion(bin, workspace.path, env, params.allowUntestedVersion === true);

    const schemaPath = path.join(workspace.path, SCHEMA_FILE);
    const jsonSchema = normalizeCodexSchema(
      z.toJSONSchema(params.schema) as Record<string, unknown>
    );
    safeWriteFile(schemaPath, JSON.stringify(jsonSchema, null, 2));

    const args = [
      'exec',
      ...CODEX_ISOLATED_EXEC_FLAGS,
      '--output-schema',
      schemaPath,
      '--json',
      '-',
    ];
    const run = await runIsolatedChild(bin, args, {
      cwd: workspace.path,
      env,
      stdin: buildCodexIsolatedPrompt(params.systemPrompt, params.userPrompt),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });

    const events = parseJsonLines(run.stdout);
    const evidence = detectCodexToolAttempt({ stderr: run.stderr, events });
    if (evidence) {
      throw new CodexIsolatedQueryError(
        `[CODEX_TOOL_ATTEMPT] codex isolated run attempted a tool — output discarded | next: inspect the prompt; never relax the isolation flags | evidence: ${evidence}`,
        'CODEX_TOOL_ATTEMPT',
        { evidence }
      );
    }
    usage = turnUsage(events);
    const failure = turnFailure(events);
    if (run.code !== 0 || failure) {
      throw new CodexIsolatedQueryError(
        `[CODEX_EXEC_FAILED] codex exec failed — exit=${run.code} | next: check codex login / network | evidence: ${(failure ?? run.stderr).slice(0, 500)}`,
        'CODEX_EXEC_FAILED'
      );
    }
    const parsed = parseLastAgentMessage(events, params.schema);
    status = 'success';
    return { parsed, rawEvents: events };
  } finally {
    recordMetrics(params.metricsLabel, Date.now() - startedAt, status, usage);
    try {
      deleteRegisteredWorkspace(workspace.id);
    } catch (error) {
      logger.warn(
        `[codex-isolated-query] scratch cleanup failed — ${(error as Error).message} | next: workspace reclaim sweeps it | evidence: ${workspace.path}`
      );
    }
  }
}

/** System prompt first (codex has no separate flag), then the caller's framed prompt. */
export function buildCodexIsolatedPrompt(systemPrompt: string, userPrompt: string): string {
  return [
    '=== SYSTEM INSTRUCTIONS (authoritative) ===',
    systemPrompt.trim(),
    'You have no usable tools. Do not call any tool; answer from the text below only.',
    '=== END SYSTEM INSTRUCTIONS ===',
    '',
    userPrompt.trim(),
    '',
    'Return exactly one JSON object that matches the provided output schema.',
  ].join('\n');
}

async function assertTestedCodexVersion(
  bin: string,
  cwd: string,
  env: Record<string, string>,
  allowUntested: boolean
): Promise<void> {
  const run = await runIsolatedChild(bin, ['--version'], {
    cwd,
    env,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const version = parseCodexCliMajorMinor(run.stdout) ?? 'unknown';
  if (run.code === 0 && TESTED_CODEX_CLI_VERSIONS.includes(version)) return;
  if (allowUntested) {
    logger.warn(
      `[codex-isolated-query] running on untested codex-cli — isolation not probed for this version | next: run the isolation probe | version=${version}`
    );
    return;
  }
  throw new CodexIsolatedQueryError(
    `[CODEX_ISOLATION_UNTESTED] codex-cli version is not isolation-tested — tested: ${TESTED_CODEX_CLI_VERSIONS.join(', ')} | run the isolation probe and add the version to TESTED_CODEX_CLI_VERSIONS, or opt in with allowUntestedVersion | version=${version}`,
    'CODEX_ISOLATION_UNTESTED',
    { version }
  );
}

/**
 * Spawn through the exec-policy gate with an exact env and a killable
 * wall-clock budget (timeout and abort SIGTERM, then SIGKILL, the child).
 */
async function runIsolatedChild(
  bin: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<ChildRun> {
  assertGovernedExec(bin, args);
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    return await withWallClockBudget(
      {
        provider: 'codex',
        budgetMs: options.timeoutMs,
        child: delegationChildHandleFromChildProcess(child),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      () =>
        new Promise<ChildRun>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          let bytes = 0;
          const append = (chunk: Buffer | string, target: 'stdout' | 'stderr') => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT_BYTES) {
              child.kill('SIGKILL');
              reject(
                new CodexIsolatedQueryError(
                  '[CODEX_EXEC_FAILED] output limit exceeded',
                  'CODEX_EXEC_FAILED'
                )
              );
              return;
            }
            if (target === 'stdout') stdout += chunk.toString();
            else stderr += chunk.toString();
          };
          child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
          child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
          child.on('error', (error) =>
            reject(
              new CodexIsolatedQueryError(
                `[CODEX_EXEC_FAILED] codex spawn failed — ${error.message}`,
                'CODEX_EXEC_FAILED'
              )
            )
          );
          child.on('close', (code) => resolve({ stdout, stderr, code }));
          // A child that exits before reading stdin must not crash the caller (EPIPE).
          child.stdin.on('error', () => undefined);
          child.stdin.end(options.stdin ?? '');
        })
    );
  } catch (error) {
    if (error instanceof DelegationWallClockExceededError) {
      throw new CodexIsolatedQueryError(
        `[CODEX_TIMEOUT] codex run exceeded ${options.timeoutMs}ms`,
        'CODEX_TIMEOUT'
      );
    }
    throw error;
  }
}

function parseJsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      logger.debug('[codex-isolated-query] ignored non-JSON stdout line');
    }
  }
  return events;
}

function parseLastAgentMessage<T>(events: unknown[], schema: ZodType<T>): T {
  let text: string | undefined;
  for (const event of events) {
    const record = asRecord(event);
    if (record?.type !== 'item.completed') continue;
    const item = asRecord(record.item);
    if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
  }
  if (text === undefined) {
    throw new CodexIsolatedQueryError(
      '[CODEX_NO_RESULT] codex emitted no agent_message',
      'CODEX_NO_RESULT'
    );
  }
  let json: unknown;
  try {
    json = parseSafeJsonInput(text.trim(), 'Codex isolated structured response');
  } catch (error) {
    throw new CodexIsolatedQueryError(
      `[CODEX_PARSE_FAILED] agent_message is not JSON — ${(error as Error).message}`,
      'CODEX_PARSE_FAILED'
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new CodexIsolatedQueryError(
      `[CODEX_PARSE_FAILED] schema validation failed: ${parsed.error.message}`,
      'CODEX_PARSE_FAILED',
      { issues: parsed.error.issues }
    );
  }
  return parsed.data;
}

function turnFailure(events: unknown[]): string | undefined {
  for (const event of events) {
    const record = asRecord(event);
    // Top-level `error` events include transient retries; only a failed turn is fatal.
    if (record?.type === 'turn.failed') {
      return JSON.stringify(record).slice(0, 500);
    }
  }
  return undefined;
}

function turnUsage(events: unknown[]): Record<string, number> | undefined {
  for (const event of events) {
    const record = asRecord(event);
    if (record?.type !== 'turn.completed') continue;
    const usage = asRecord(record.usage);
    if (!usage) continue;
    const value = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return {
      prompt_tokens: value('input_tokens'),
      completion_tokens: value('output_tokens'),
      cache_read_tokens: value('cached_input_tokens'),
    };
  }
  return undefined;
}

function recordMetrics(
  label: string | undefined,
  durationMs: number,
  status: 'success' | 'error',
  usage: Record<string, number> | undefined
): void {
  try {
    metrics.record(label ?? 'reasoning:codex-isolated', durationMs, status, {
      agent: 'codex-cli',
      cause: 'subagent',
      ...(usage ? { usage } : {}),
    });
  } catch {
    // metrics is best-effort; never disrupt reasoning
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
