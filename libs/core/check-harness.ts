import { defineCommand, type CommandContext } from './command-harness.js';
import { ScriptExitError } from './script-harness.js';
import type { CliOptionSpec } from './cli-guard.js';

export interface CheckFinding {
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface CheckResult {
  ok: boolean;
  id: string;
  findings: CheckFinding[];
}

/** The CI gate catalog decides whether to schedule a check; collection never decides its exit code. */
export function defineCheck(spec: {
  id: string;
  manifestId?: string;
  options?: readonly CliOptionSpec[];
  positionals?: string;
  collect(context: CommandContext): CheckFinding[] | Promise<CheckFinding[]>;
  render?(findings: readonly CheckFinding[]): string | readonly string[];
}) {
  return defineCommand<CheckResult>({
    name: `check:${spec.id}`,
    manifestId: spec.manifestId,
    options: spec.options,
    positionals: spec.positionals,
    async run(context) {
      const findings = await spec.collect(context);
      const result: CheckResult = { ok: findings.length === 0, id: spec.id, findings };
      if (context.json) context.print(result);
      else if (result.ok) context.print(`[check:${spec.id}] OK`);
      else {
        const rendered =
          spec.render?.(findings) ??
          findings.map(
            (finding) =>
              `[check:${spec.id}] ${finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}: ` : ''}${finding.code}: ${finding.message}`
          );
        for (const line of typeof rendered === 'string' ? [rendered] : rendered)
          context.print(line);
      }
      if (!result.ok) throw new ScriptExitError(1, '', true, result);
      return result;
    },
  });
}
