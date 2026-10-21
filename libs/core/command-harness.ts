import { parseGuardedCliArgs, type CliOptionSpec } from './cli-guard.js';
import { defineScript, type ScriptContext } from './script-harness.js';

export interface CommandContext extends ScriptContext {
  options: Readonly<Record<string, string | boolean>>;
  positionals: readonly string[];
}

/** Composition of the shared guard grammar and script output/error boundary. */
export function defineCommand<T>(spec: {
  name: string;
  command?: string;
  manifestId?: string;
  positionals?: string;
  options?: readonly CliOptionSpec[];
  run(context: CommandContext): T | Promise<T>;
}): (argv?: string[]) => Promise<T | undefined> {
  return defineScript({
    name: spec.name,
    async run(context) {
      const parsed = parseGuardedCliArgs(
        context.argv,
        {
          command: spec.command ?? `pnpm ${spec.name}`,
          manifestId: spec.manifestId,
          positional: spec.positionals,
          options: [
            ...(spec.options ?? []),
            { flag: '--json' },
            { flag: '--quiet' },
            { flag: '--dry-run' },
            { flag: '--check' },
          ],
        },
        context.print
      );
      if (parsed.handled) return undefined as T;
      return spec.run({ ...context, options: parsed.options, positionals: parsed.positionals });
    },
  });
}
