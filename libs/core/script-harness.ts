import { assertSafeRepositoryPath, safeExistsSync, safeWriteFile } from './secure-io.js';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import { readTextFile } from './foundation/text.js';
import { withExecutionContext } from './authority.js';
import { isDirectEntry } from './direct-entry.js';
import { DiagnosticError } from './logger.js';

export interface ScriptFlags {
  json: boolean;
  dryRun: boolean;
  check: boolean;
  quiet: boolean;
  positional: string[];
  /** Flags not owned by the shared harness; callers must opt into handling them. */
  unknownFlags: string[];
}

export interface ScriptContext extends ScriptFlags {
  name: string;
  argv: string[];
  print(value: unknown): void;
}

export type ScriptFlag = 'json' | 'dry-run' | 'check' | 'quiet';

export class ScriptExitError extends Error {
  constructor(
    public readonly code: number,
    message = '',
    public readonly silent = message.length === 0,
    public readonly returnValue?: unknown
  ) {
    super(message);
    this.name = 'ScriptExitError';
  }
}

const DEFAULT_SCRIPT_FLAGS: readonly ScriptFlag[] = ['json', 'dry-run', 'check', 'quiet'];
const SHARED_SCRIPT_FLAG_VALUES = new Set(['--', '--json', '--dry-run', '--check', '--quiet']);

/** Return the full process argv for legacy APIs whose parsers expect node/script prefixes. */
export function currentProcessArgv(): string[] {
  return [...process.argv];
}

/** Terminate a CLI process through the single governed process boundary. */
export function exitProcess(code: number): never {
  process.exitCode = code;
  throw new ScriptExitError(code, '', true);
}

/** Set a final exit status for asynchronous processes without terminating them. */
export function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

/** Read a nested script's pending exit status without exposing process globals to callers. */
export function getProcessExitCode(): number | undefined {
  const code = process.exitCode;
  return code === undefined ? undefined : Number(code);
}

/** Clear a nested script's pending exit status before returning to a caller. */
export function clearProcessExitCode(): void {
  process.exitCode = undefined;
}

/** Replace process argv for legacy child-entry modules that inspect it directly. */
export function setCurrentProcessArgv(argv: string[]): void {
  process.argv = [...argv];
}

export function parseScriptFlags(
  argv: string[],
  enabledFlags: readonly ScriptFlag[] = DEFAULT_SCRIPT_FLAGS
): ScriptFlags {
  const enabled = new Set(enabledFlags);
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  let json = false;
  let dryRun = false;
  let check = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--json' && enabled.has('json')) json = true;
    else if (arg === '--dry-run' && enabled.has('dry-run')) dryRun = true;
    else if (arg === '--check' && enabled.has('check')) check = true;
    else if (arg === '--quiet' && enabled.has('quiet')) quiet = true;
    else {
      positional.push(arg);
      if (arg.startsWith('-') && arg !== '--') unknownFlags.push(arg);
    }
  }
  return { json, dryRun, check, quiet, positional, unknownFlags };
}

/** Remove flags owned by the shared harness before delegating to a legacy parser. */
export function stripSharedScriptFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !SHARED_SCRIPT_FLAG_VALUES.has(arg));
}

// --- failure rendering -----------------------------------------------------
// The harness is the single failure boundary for every `defineScript` CLI.
// It prints `error.message` plus a `next:` remediation hint — never a raw
// stack — unless DEBUG is set, matching the `core.ts` convention.

export interface ScriptErrorReport {
  /** Operator-facing message — never contains a stack trace. */
  message: string;
  /** Remediation hint when the error did not already carry `| next:` text. */
  next?: string;
  /** Stack text, present only when DEBUG is enabled. */
  stack?: string;
}

const ERRNO_NEXT_HINTS: Readonly<Record<string, string>> = Object.freeze({
  ENOENT: 'verify the path exists, then retry',
  EACCES: 'check file permissions or run with sufficient privileges',
  EPERM: 'check file permissions or run with sufficient privileges',
  ENOSPC: 'free disk space, then retry',
  ECONNREFUSED: 'confirm the target service is running and reachable',
  ETIMEDOUT: 'check network connectivity, then retry',
  ESOCKETTIMEDOUT: 'check network connectivity, then retry',
  ENOTFOUND: 'check the hostname or DNS resolution',
  EADDRINUSE: 'another process holds the port — stop it or choose a different port',
  ERR_MODULE_NOT_FOUND: 'run `pnpm build` to regenerate dist/',
});

function errorNextHint(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ERRNO_NEXT_HINTS[code]) return ERRNO_NEXT_HINTS[code];
  if (error instanceof SyntaxError && /json/i.test(error.message)) {
    return 'the input is not valid JSON — fix or regenerate the file';
  }
  if (/Cannot find module/.test(error.message)) {
    return ERRNO_NEXT_HINTS.ERR_MODULE_NOT_FOUND;
  }
  return undefined;
}

/**
 * Render an unknown thrown value into an operator-facing report. Plain
 * `Error`s get a remediation hint when their class or message maps to a known
 * failure; `DiagnosticError`s already carry `next`, so nothing is appended.
 * Stacks are attached only when DEBUG (or `options.debug`) is set.
 */
export function renderScriptError(
  error: unknown,
  options: { debug?: boolean } = {}
): ScriptErrorReport {
  if (!(error instanceof Error)) return { message: String(error) };
  const report: ScriptErrorReport = { message: error.message || String(error) };
  if (!(error instanceof DiagnosticError) && !/\| next:/u.test(report.message)) {
    report.next = errorNextHint(error);
  }
  const debug = options.debug ?? Boolean(getRegisteredEnvText('DEBUG'));
  if (debug && error.stack) report.stack = error.stack;
  return report;
}

export function defineScript<T>(options: {
  name: string;
  flags?: readonly ScriptFlag[];
  run(context: ScriptContext): T | Promise<T>;
}): (argv?: string[]) => Promise<T | undefined> {
  return async (argv = process.argv.slice(2)): Promise<T | undefined> => {
    const flags = parseScriptFlags(argv, options.flags ?? DEFAULT_SCRIPT_FLAGS);
    const previousLogLevel = getRegisteredEnvText('LOG_LEVEL');
    const suppressLogs = flags.quiet || flags.json;
    if (suppressLogs) setRegisteredEnv('LOG_LEVEL', 'silent');
    const output = (value: unknown): void => {
      if (!flags.quiet) {
        const rendered =
          flags.json && typeof value === 'string'
            ? value
            : flags.json || (typeof value === 'object' && value !== null)
              ? JSON.stringify(value, null, 2)
              : String(value);
        console.log(rendered);
      }
    };
    try {
      try {
        return await options.run({ ...flags, name: options.name, argv, print: output });
      } catch (error) {
        const exitCode = error instanceof ScriptExitError ? error.code : 1;
        const silent = error instanceof ScriptExitError && error.silent;
        if (!silent) {
          const report =
            error instanceof ScriptExitError
              ? { message: error.message }
              : renderScriptError(error);
          if (!flags.json) {
            console.error(`[${options.name}] ${report.message}`);
            if (report.next) console.error(`  next: ${report.next}`);
            if (report.stack) console.error(report.stack);
          } else {
            console.error(
              JSON.stringify({
                ok: false,
                error: report.message,
                ...(report.next ? { next: report.next } : {}),
                ...(report.stack ? { stack: report.stack } : {}),
              })
            );
          }
        }
        process.exitCode = exitCode;
        if (error instanceof ScriptExitError && error.returnValue !== undefined) {
          return error.returnValue as T;
        }
        return undefined;
      }
    } finally {
      setRegisteredEnv('LOG_LEVEL', previousLogLevel);
    }
  };
}

export interface GeneratedFile {
  path: string;
  content: string;
}

type GeneratorOutputs =
  | readonly string[]
  | ((context: ScriptContext, files: readonly GeneratedFile[]) => readonly string[]);

function formatGeneratorUsage(id: string, extraFlags: readonly string[]): string {
  const flags = ['--check', '--dry-run', '--json', '--quiet', ...extraFlags, '--help'];
  return `Usage: pnpm generate:${id} [${flags.join('] [')}]\n\n  --check    verify generated files are up to date without writing\n  --dry-run  report changes without writing\n  --help     show this usage (no files are written)`;
}

export function defineGenerator(options: {
  id: string;
  outputs: GeneratorOutputs;
  executionContext?: string;
  /** Generator-specific flags (e.g. `--out`) accepted in addition to the shared harness flags. */
  flags?: readonly string[];
  normalize?: (content: string) => string;
  render(context: ScriptContext): GeneratedFile[] | Promise<GeneratedFile[]>;
}): (argv?: string[]) => Promise<{ changed: string[]; files: GeneratedFile[] } | undefined> {
  return defineScript({
    name: `generate:${options.id}`,
    async run(context) {
      if (context.argv.some((arg) => arg === '--help' || arg === '-h')) {
        context.print(formatGeneratorUsage(options.id, options.flags ?? []));
        return undefined;
      }
      const allowed = new Set(['--help', '-h', ...(options.flags ?? [])]);
      const unknown = context.unknownFlags.filter(
        (flag) => !allowed.has(flag.split('=')[0] ?? flag)
      );
      if (unknown.length > 0) {
        throw new ScriptExitError(
          2,
          `unknown option ${unknown.join(', ')}\n${formatGeneratorUsage(options.id, options.flags ?? [])}`
        );
      }
      const files = await options.render(context);
      const normalize = options.normalize ?? ((content: string) => content);
      const declaredOutputs =
        typeof options.outputs === 'function' ? options.outputs(context, files) : options.outputs;
      const safeFiles = files.map((file) => ({
        ...file,
        safePath: assertSafeRepositoryPath(file.path, { allowMissingLeaf: true }),
      }));
      const safeDeclaredOutputs = declaredOutputs.map((filePath) =>
        assertSafeRepositoryPath(filePath, { allowMissingLeaf: true })
      );
      const changed = files
        .filter((file, index) => {
          const safePath = safeFiles[index]?.safePath as string;
          if (!safeExistsSync(safePath)) return true;
          return normalize(readTextFile(safePath)) !== normalize(file.content);
        })
        .map((file) => file.path);
      const unexpected = files
        .map((file, index) => ({ path: file.path, safePath: safeFiles[index]?.safePath as string }))
        .filter((file) => !safeDeclaredOutputs.includes(file.safePath))
        .map((file) => file.path);
      if (unexpected.length > 0)
        throw new ScriptExitError(
          1,
          `generator emitted undeclared outputs: ${unexpected.join(', ')}`
        );
      if (!context.check && !context.dryRun) {
        withExecutionContext(options.executionContext ?? 'ecosystem_architect', () => {
          for (const file of safeFiles) safeWriteFile(file.safePath, file.content);
        });
      }
      const result = { changed, files };
      context.print({
        ok: changed.length === 0 || !context.check,
        changed,
        files: files.map((file) => file.path),
      });
      if (context.check && changed.length > 0) {
        throw new ScriptExitError(1, '', true, result);
      }
      return result;
    },
  });
}

export function isDirectScript(importMetaUrl: string, expectedFile: string): boolean {
  return isDirectEntry(importMetaUrl, expectedFile);
}
