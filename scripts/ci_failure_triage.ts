#!/usr/bin/env node
/**
 * `pnpm kyberion ci triage [log-file ...] [--job <name>] [--json]` — classify a
 * red CI log and print the exact next command per failure (dev-cycle plan M4).
 *
 * Input: one or more plain-text CI logs (a captured step log, or
 * `gh run view <id> --log-failed` output); with no file, stdin. ANSI codes and
 * GitHub timestamp prefixes are stripped. Output: Markdown (default) or JSON.
 * The command is a reporter — it exits 0 whatever it finds; a missing input
 * file exits 1.
 *
 * Wired into CI by `.github/actions/ci-failure-triage` (job summary on
 * failure) and `.github/workflows/main-failure-triage.yml` (one issue per
 * failing signature on main). Classification lives in
 * `scripts/lib/ci-failure-triage.ts`; who acts on which class is in the
 * operations-hygiene runbook §1.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, normalizeInlineValueFlags, type CliGuardSpec } from './lib/cli-guard.js';
import { readSafeJsonFile } from './lib/json-input.js';
import {
  renderFailureMarkdown,
  renderTriageMarkdown,
  triageCiLog,
  type GateRemedy,
  type TriageReport,
} from './lib/ci-failure-triage.js';

export const CI_TRIAGE_CLI: CliGuardSpec = {
  command: 'pnpm kyberion ci triage',
  manifestId: 'script.ci.triage',
  positional: '[log-file ...]',
  options: [{ flag: '--job', value: '<name>' }, { flag: '--json' }, { flag: '--quiet' }],
};

interface GateManifestLike {
  gates: Array<{ id: string; executable?: string; args?: string[] }>;
}

/**
 * Map each freshness gate (`scripts/generate_*.ts --check`,
 * `scripts/analyze_*.ts --check`) to the command that rewrites its output: the
 * package script that runs the same file without `--check` when one exists,
 * otherwise the gate's own command minus `--check`.
 */
export function deriveGateRemedies(
  manifest: GateManifestLike,
  packageScripts: Readonly<Record<string, string>>
): Record<string, GateRemedy> {
  const remedies: Record<string, GateRemedy> = {};
  for (const gate of manifest.gates) {
    const args = gate.args ?? [];
    const remedy: GateRemedy = { check: `pnpm check -- --only ${gate.id}` };
    const scriptFile = args.find((arg) => /^scripts\/(?:generate|analyze)_[\w-]+\.ts$/u.test(arg));
    if (scriptFile && args.includes('--check')) {
      const packageScript = Object.entries(packageScripts)
        .filter(([, body]) => body.includes(scriptFile) && !body.includes('--check'))
        .map(([name]) => name)
        .sort((left, right) => left.length - right.length || (left < right ? -1 : 1))[0];
      remedy.generator = packageScript
        ? `pnpm ${packageScript}`
        : [gate.executable ?? 'node', ...args.filter((arg) => arg !== '--check')].join(' ');
    }
    remedies[gate.id] = remedy;
  }
  return remedies;
}

export function loadGateRemedies(): Record<string, GateRemedy> {
  const manifest = readSafeJsonFile<GateManifestLike>(
    pathResolver.rootResolve('knowledge/product/governance/ci-gates.json'),
    'CI gate manifest'
  );
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json'),
    'package manifest'
  );
  return deriveGateRemedies(manifest, packageJson.scripts ?? {});
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function parseArgs(argv: readonly string[]): { files: string[]; job?: string } {
  const files: string[] = [];
  let job: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--job') job = argv[++index];
    else if (arg === '--' || arg === '--json' || arg === '--quiet') continue;
    else files.push(arg);
  }
  return { files, ...(job ? { job } : {}) };
}

export const main = defineScript({
  name: 'ci:triage',
  flags: ['json', 'quiet'],
  async run(context): Promise<TriageReport | undefined> {
    if (guardCliArgs(context.argv, CI_TRIAGE_CLI, context.print)) return undefined;
    const { files, job } = parseArgs(normalizeInlineValueFlags(context.argv, CI_TRIAGE_CLI));
    const inputs: string[] = [];
    for (const file of files) {
      if (file === '-') {
        inputs.push(await readStdin());
        continue;
      }
      if (!safeExistsSync(file)) throw new ScriptExitError(1, `log file not found: ${file}`);
      inputs.push(readTextFile(file));
    }
    if (files.length === 0) inputs.push(await readStdin());
    const report = triageCiLog(inputs.join('\n'), {
      ...(job ? { job } : {}),
      gateRemedies: loadGateRemedies(),
    });
    // JSON carries each failure's rendered section so the main-failure-triage
    // workflow can file it as an issue body without re-rendering in shell.
    context.print(
      context.json
        ? {
            ...report,
            failures: report.failures.map((failure) => ({
              ...failure,
              markdown: renderFailureMarkdown(failure, '##'),
            })),
          }
        : renderTriageMarkdown(report)
    );
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'ci_failure_triage.ts') ||
  isDirectScript(import.meta.url, 'ci_failure_triage.js')
)
  void main();
