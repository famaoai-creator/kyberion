import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

export interface ScriptFlags {
  json: boolean;
  dryRun: boolean;
  check: boolean;
  quiet: boolean;
  positional: string[];
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
    public readonly silent = message.length === 0
  ) {
    super(message);
    this.name = 'ScriptExitError';
  }
}

const DEFAULT_SCRIPT_FLAGS: readonly ScriptFlag[] = ['json', 'dry-run', 'check', 'quiet'];

/** Return the full process argv for legacy APIs whose parsers expect node/script prefixes. */
export function currentProcessArgv(): string[] {
  return [...process.argv];
}

export function parseScriptFlags(
  argv: string[],
  enabledFlags: readonly ScriptFlag[] = DEFAULT_SCRIPT_FLAGS
): ScriptFlags {
  const enabled = new Set(enabledFlags);
  const positional: string[] = [];
  let json = false;
  let dryRun = false;
  let check = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--json' && enabled.has('json')) json = true;
    else if (arg === '--dry-run' && enabled.has('dry-run')) dryRun = true;
    else if (arg === '--check' && enabled.has('check')) check = true;
    else if (arg === '--quiet' && enabled.has('quiet')) quiet = true;
    else positional.push(arg);
  }
  return { json, dryRun, check, quiet, positional };
}

export function defineScript<T>(options: {
  name: string;
  flags?: readonly ScriptFlag[];
  run(context: ScriptContext): T | Promise<T>;
}): (argv?: string[]) => Promise<T | undefined> {
  return async (argv = process.argv.slice(2)): Promise<T | undefined> => {
    const flags = parseScriptFlags(argv, options.flags);
    const output = (value: unknown): void => {
      if (!flags.quiet) {
        const rendered =
          flags.json || (typeof value === 'object' && value !== null)
            ? JSON.stringify(value, null, 2)
            : String(value);
        console.log(rendered);
      }
    };
    try {
      return await options.run({ ...flags, name: options.name, argv, print: output });
    } catch (error) {
      const exitCode = error instanceof ScriptExitError ? error.code : 1;
      const silent = error instanceof ScriptExitError && error.silent;
      if (!silent) {
        const message = error instanceof ScriptExitError ? error.message : String(error);
        if (!flags.json) console.error(`[${options.name}] ${message}`);
        else console.error(JSON.stringify({ ok: false, error: message }));
      }
      process.exitCode = exitCode;
      return undefined;
    }
  };
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export function defineGenerator(options: {
  id: string;
  outputs: string[];
  executionContext?: string;
  normalize?: (content: string) => string;
  render(context: ScriptContext): GeneratedFile[] | Promise<GeneratedFile[]>;
}): (argv?: string[]) => Promise<{ changed: string[]; files: GeneratedFile[] } | undefined> {
  return defineScript({
    name: `generate:${options.id}`,
    async run(context) {
      const files = await options.render(context);
      const normalize = options.normalize ?? ((content: string) => content);
      const changed = files
        .filter((file) => {
          if (!safeExistsSync(file.path)) return true;
          return normalize(String(safeReadFile(file.path))) !== normalize(file.content);
        })
        .map((file) => file.path);
      const unexpected = files
        .map((file) => file.path)
        .filter((file) => !options.outputs.includes(file));
      if (unexpected.length > 0)
        throw new Error(`generator emitted undeclared outputs: ${unexpected.join(', ')}`);
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
        process.exitCode = 1;
      }
      return result;
    },
  });
}

export function isDirectScript(importMetaUrl: string, expectedFile: string): boolean {
  return (
    path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(importMetaUrl)) &&
    process.argv[1]?.endsWith(expectedFile) === true
  );
}
