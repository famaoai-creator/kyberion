import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/governance';
import { isDirectEntry } from '@agent/core/direct-entry';

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
  process.exit(code);
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
      if (arg.startsWith('-')) unknownFlags.push(arg);
    }
  }
  return { json, dryRun, check, quiet, positional, unknownFlags };
}

/** Remove flags owned by the shared harness before delegating to a legacy parser. */
export function stripSharedScriptFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !SHARED_SCRIPT_FLAG_VALUES.has(arg));
}

export function defineScript<T>(options: {
  name: string;
  flags?: readonly ScriptFlag[];
  run(context: ScriptContext): T | Promise<T>;
}): (argv?: string[]) => Promise<T | undefined> {
  return async (argv = process.argv.slice(2)): Promise<T | undefined> => {
    const flags = parseScriptFlags(argv, options.flags ?? DEFAULT_SCRIPT_FLAGS);
    const previousLogLevel = process.env.LOG_LEVEL;
    const suppressLogs = flags.quiet || flags.json;
    if (suppressLogs) process.env.LOG_LEVEL = 'silent';
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
          const message =
            error instanceof ScriptExitError
              ? error.message
              : error instanceof Error
                ? error.stack || error.message
                : String(error);
          if (!flags.json) console.error(`[${options.name}] ${message}`);
          else console.error(JSON.stringify({ ok: false, error: message }));
        }
        process.exitCode = exitCode;
        if (error instanceof ScriptExitError && error.returnValue !== undefined) {
          return error.returnValue as T;
        }
        return undefined;
      }
    } finally {
      if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLogLevel;
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

export function defineGenerator(options: {
  id: string;
  outputs: GeneratorOutputs;
  executionContext?: string;
  normalize?: (content: string) => string;
  render(context: ScriptContext): GeneratedFile[] | Promise<GeneratedFile[]>;
}): (argv?: string[]) => Promise<{ changed: string[]; files: GeneratedFile[] } | undefined> {
  return defineScript({
    name: `generate:${options.id}`,
    async run(context) {
      const files = await options.render(context);
      const normalize = options.normalize ?? ((content: string) => content);
      const declaredOutputs =
        typeof options.outputs === 'function' ? options.outputs(context, files) : options.outputs;
      const changed = files
        .filter((file) => {
          if (!safeExistsSync(file.path)) return true;
          return normalize(String(safeReadFile(file.path))) !== normalize(file.content);
        })
        .map((file) => file.path);
      const unexpected = files
        .map((file) => file.path)
        .filter((file) => !declaredOutputs.includes(file));
      if (unexpected.length > 0)
        throw new ScriptExitError(
          1,
          `generator emitted undeclared outputs: ${unexpected.join(', ')}`
        );
      if (!context.check && !context.dryRun) {
        withExecutionContext(options.executionContext ?? 'ecosystem_architect', () => {
          for (const file of files) safeWriteFile(file.path, file.content);
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
