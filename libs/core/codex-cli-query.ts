/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import { recordEstimatedCliUsage } from './cli-usage-metering.js';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { readTextFile } from './foundation/text.js';
import * as pathResolver from './path-resolver.js';
import { safeExecResult, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  buildProviderChildEnv,
  resolveEffectiveProviderPermissionProfile,
  resolveProviderPermissionArgs,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import {
  delegationChildHandleFromChildProcess,
  withWallClockBudget,
  DelegationWallClockExceededError,
} from './delegation-concurrency.js';

export interface CodexCliQueryOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  cwd?: string;
  signal?: AbortSignal;
}

export interface RunCodexCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  mode?: 'read-only' | 'workspace-write';
  /**
   * XP-02 follow-up: KD-05 capability profile. When set, its provider
   * permission mapping (see {@link resolveProviderPermissionArgs}) supplies
   * the `--sandbox` argv fragment instead of `mode`. Omit (the historical
   * default) to keep `mode`-driven argv byte-identical to callers that
   * predate this option.
   */
  profile?: ProviderPermissionProfileName;
  options?: CodexCliQueryOptions;
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

export async function runCodexCliQuery<T>({
  systemPrompt,
  userPrompt,
  schema,
  mode = 'read-only',
  profile,
  options = {},
}: RunCodexCliQueryParams<T>): Promise<T> {
  const query = new CodexCliQuery(options);
  return query.runStructured({ systemPrompt, userPrompt, schema, mode, profile });
}

class CodexCliQuery {
  private readonly options: CodexCliQueryOptions;
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly cwd: string;

  constructor(options: CodexCliQueryOptions = {}) {
    this.options = options;
    this.bin = options.bin ?? resolveCodexBinary();
    this.model = options.model ?? resolveRuntimeModelId('codex-default');
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
    this.cwd = options.cwd ?? pathResolver.rootDir();
  }

  async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
    mode: 'read-only' | 'workspace-write';
    profile?: ProviderPermissionProfileName;
  }): Promise<T> {
    // Resolved before any file I/O or spawn so a typed refusal (e.g.
    // planner, which codex has no safe no-exec mode for) never touches the
    // filesystem or attempts to spawn the CLI.
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('codex', params.profile);
    const sandboxArgs = effectiveProfile
      ? this.resolvePermissionArgs(effectiveProfile)
      : ['--sandbox', params.mode];

    const schemaJson = normalizeCodexSchema(
      z.toJSONSchema(params.schema) as Record<string, unknown>
    );
    const schemaPath = this.tempFilePath('codex-schema', 'json');
    const outputPath = this.tempFilePath('codex-output', 'json');
    safeWriteFile(schemaPath, JSON.stringify(schemaJson, null, 2), { mkdir: true });

    try {
      const prompt = [
        params.systemPrompt.trim(),
        '',
        params.userPrompt.trim(),
        '',
        'Return exactly one JSON object that matches the provided output schema.',
        'Do not wrap the JSON in markdown fences.',
      ].join('\n');
      const args = [
        'exec',
        ...sandboxArgs,
        '--model',
        this.model,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '--color',
        'never',
        '-C',
        this.cwd,
        ...this.extraArgs,
        '-',
      ];

      const started = Date.now();
      try {
        await this.spawnCli(args, prompt);
      } catch (err) {
        recordEstimatedCliUsage('codex-cli', this.model, started, 'error', prompt.length, 0);
        throw err;
      }

      const raw = readTextFile(outputPath);
      recordEstimatedCliUsage(
        'codex-cli',
        this.model,
        started,
        'success',
        prompt.length,
        raw.length
      );
      const clean = extractJsonPayload(raw);
      const parsedJson = parseSafeJsonInput(clean, 'Codex CLI structured response');
      const parsed = params.schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(`[codex-cli] schema validation failed: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (err: any) {
      throw new Error(`[codex-cli] structured query failed: ${err?.message ?? String(err)}`);
    } finally {
      safeRmSync(schemaPath, { force: true });
      safeRmSync(outputPath, { force: true });
    }
  }

  /**
   * XP-06: real async `spawn` (not `spawnSync`), so the wall-clock budget is
   * enforced against a real, killable handle via {@link withWallClockBudget}
   * — expiry actually SIGTERM's then SIGKILL's this CLI process.
   */
  private spawnCli(args: string[], stdin: string): Promise<void> {
    const child = spawn(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // XP-02: minimal allowlisted env, scoped to codex's own required vars.
      env: buildProviderChildEnv({ provider: 'codex' }),
      cwd: this.cwd,
    });

    return withWallClockBudget(
      {
        provider: 'codex',
        budgetMs: this.timeoutMs,
        child: delegationChildHandleFromChildProcess(child),
        signal: this.options.signal,
      },
      () =>
        new Promise<void>((resolve, reject) => {
          let stderr = '';
          let stdout = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.on('close', (code) => {
            if (code !== 0) {
              reject(
                new Error(
                  `[codex-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 1000)} stdout: ${stdout.slice(0, 500)}`
                )
              );
              return;
            }
            resolve();
          });
          child.on('error', (err) => {
            reject(new Error(`[codex-cli] spawn failed: ${err.message}`));
          });
          child.stdin.write(stdin);
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[codex-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }

  /**
   * XP-02 follow-up: resolve a KD-05 capability profile to codex CLI argv
   * fragments (the `--sandbox <mode>` pair). A typed refusal (e.g. planner
   * — codex has no verified no-exec mode) throws before any spawn.
   */
  private resolvePermissionArgs(profile: ProviderPermissionProfileName): string[] {
    const resolution = resolveProviderPermissionArgs(profile, 'codex');
    if (resolution.kind === 'refused') {
      throw new Error(`[codex-cli] permission profile "${profile}" refused: ${resolution.reason}`);
    }
    return [...resolution.args];
  }

  private tempFilePath(prefix: string, extension: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return path.join(pathResolver.sharedTmp(), `kyberion-${prefix}-${id}.${extension}`);
  }
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/u) || trimmed.match(/```\s*([\s\S]*?)```/u);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function normalizeCodexSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  normalizeSchemaNode(clone);
  return clone;
}

function normalizeSchemaNode(node: unknown): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) normalizeSchemaNode(item);
    return;
  }

  const record = node as Record<string, unknown>;

  if (
    record.properties &&
    typeof record.properties === 'object' &&
    !Array.isArray(record.properties)
  ) {
    const properties = record.properties as Record<string, unknown>;
    const originalRequired = Array.isArray(record.required)
      ? new Set(
          (record.required as unknown[]).filter(
            (value): value is string => typeof value === 'string'
          )
        )
      : new Set<string>();
    for (const [key, value] of Object.entries(properties)) {
      normalizeSchemaNode(value);
      properties[key] = originalRequired.has(key) ? value : ensureNullable(value);
    }
    record.required = Object.keys(properties);
  }

  if (record.items) normalizeSchemaNode(record.items);
  if (Array.isArray(record.anyOf)) record.anyOf.forEach(normalizeSchemaNode);
  if (Array.isArray(record.oneOf)) record.oneOf.forEach(normalizeSchemaNode);
  if (Array.isArray(record.allOf)) record.allOf.forEach(normalizeSchemaNode);
}

function ensureNullable(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const record = node as Record<string, unknown>;

  if (record.anyOf && Array.isArray(record.anyOf)) {
    if (!record.anyOf.some((entry) => isNullSchema(entry))) {
      record.anyOf = [...record.anyOf, { type: 'null' }];
    }
    return record;
  }

  if (record.oneOf && Array.isArray(record.oneOf)) {
    if (!record.oneOf.some((entry) => isNullSchema(entry))) {
      record.oneOf = [...record.oneOf, { type: 'null' }];
    }
    return record;
  }

  const typeValue = record.type;
  if (typeof typeValue === 'string') {
    if (typeValue !== 'null') {
      record.type = [typeValue, 'null'];
    }
    return record;
  }

  if (Array.isArray(typeValue)) {
    if (!typeValue.includes('null')) {
      record.type = [...typeValue, 'null'];
    }
  }

  return record;
}

function isNullSchema(node: unknown): boolean {
  return Boolean(
    node &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    (node as Record<string, unknown>).type === 'null'
  );
}

export function buildCodexCliQueryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CodexCliQueryOptions {
  const bin = envText(env, 'KYBERION_CODEX_CLI_BIN')?.trim();
  const model = envText(env, 'KYBERION_CODEX_CLI_MODEL')?.trim();
  const timeoutRaw = envText(env, 'KYBERION_CODEX_CLI_TIMEOUT_MS')?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = envText(env, 'KYBERION_CODEX_CLI_EXTRA_ARGS')?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/u).filter(Boolean) : undefined;

  logger.info(
    `[codex-cli] query helper ready (bin=${bin ?? '<deferred>'}, model=${model ?? resolveRuntimeModelId('codex-default', env)})`
  );

  return {
    // Keep binary discovery lazy. Building a reasoning backend is safe during
    // CI/bootstrap even when Codex is not installed; the actual query
    // constructor resolves the binary immediately before spawning it.
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

// SYNC, NOT WALL-CLOCK-BUDGETED (XP-06): binary discovery, not a delegation's
// unit of work — `safeExecResult` below runs a synchronous `which -a codex`
// (its own short, hardcoded 5s timeout) and never goes through `spawnCli`/
// `withWallClockBudget`. Nothing to register or kill mid-flight from the
// same thread; this function has already returned by the time any caller
// could try.
export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envText(env, 'KYBERION_CODEX_CLI_BIN')?.trim();
  if (explicit) return explicit;

  const repoRoot = pathResolver.rootDir();
  // `which` is not a stock Windows command.  Using it on Git Bash can also
  // return POSIX-style `/c/...` paths which Node resolves incorrectly as
  // `C:\\c\\...`; ask the native resolver on Windows instead.
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const resolverArgs = process.platform === 'win32' ? ['codex'] : ['-a', 'codex'];
  const whichResult = safeExecResult(resolver, resolverArgs, {
    env,
    cwd: repoRoot,
    timeoutMs: 5000,
  });
  const candidates = whichResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    // Use a separator-independent abstract path for resolver output. This
    // keeps Windows-style `C:\\...` candidates testable on POSIX and avoids
    // host-specific path resolution in the policy itself.
    const normalized = candidate.replaceAll('\\', '/');
    if (isProjectLocalCodexShim(normalized)) continue;
    return candidate;
  }

  throw new Error(
    '[codex-cli] no acceptable Codex binary found on PATH; all discovered candidates were project-local shims. Set KYBERION_CODEX_CLI_BIN to an explicit executable.'
  );
}

function isProjectLocalCodexShim(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLocaleLowerCase('en-US');
  return (
    normalized.includes('/node_modules/.bin/codex') ||
    normalized.includes('/.codex/tmp/arg0/codex') ||
    normalized.includes('/.pnpm/@openai+codex') ||
    normalized.includes('/node_modules/@openai/codex/')
  );
}
