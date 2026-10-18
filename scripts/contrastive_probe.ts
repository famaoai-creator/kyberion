/**
 * contrastive_probe — run the harness2 Propose-Probe-Compose probe stage for a
 * repeating work shape. Candidates are supplied as overlay directories; this
 * executes them on the same scenario, classifies the evidence on the decision
 * axis, and writes a report.
 */

import { runContrastiveSession } from '@agent/core/harnessing/contrastive-session';
import type { MetricSpec } from '@agent/core/harnessing/decision-axis';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    (out[key] ??= []).push(val);
  }
  return out;
}

export const runContrastiveProbe = defineScript({
  name: 'contrastive_probe',
  run: (context: { argv: string[] }) => {
    const args = parseArgs(context.argv);
    const scenario = args['scenario']?.[0];
    const runRoot = args['run-root']?.[0];
    const commandRaw = args['command']?.[0];
    if (!scenario || !runRoot || !commandRaw) {
      throw new ScriptExitError(
        2,
        'Usage: contrastive_probe --scenario <dir> --candidate <label>=<dir> [--candidate ...] --command "<argv>" --run-root <dir> [--expect <rel>] [--metric <key>:lower|higher] [--work-shape <name>]'
      );
    }
    const candidates = (args['candidate'] ?? []).map((entry) => {
      const eq = entry.indexOf('=');
      if (eq < 0) {
        throw new ScriptExitError(2, `--candidate expects <label>=<overlay-dir>, got ${entry}`);
      }
      return { label: entry.slice(0, eq), overlayDir: entry.slice(eq + 1) };
    });
    const metrics: MetricSpec[] = (args['metric'] ?? []).map((m) => {
      const [key, dir] = m.split(':');
      if (dir !== 'lower' && dir !== 'higher') {
        throw new ScriptExitError(2, `--metric expects <key>:lower|higher, got ${m}`);
      }
      return { key, direction: dir };
    });
    const command = commandRaw.split(/\s+/).filter(Boolean);
    const result = runContrastiveSession({
      session_id: `ppc-${Date.now().toString(36)}`,
      scenarioDir: scenario,
      command,
      candidates,
      expectOutputs: args['expect'] ?? [],
      metrics,
      runRoot,
      work_shape: args['work-shape']?.[0],
    });
    console.log(JSON.stringify(result.decision, null, 2));
    console.log(`report: ${result.report_path}`);
  },
});

if (
  isDirectScript(import.meta.url, 'contrastive_probe.ts') ||
  isDirectScript(import.meta.url, 'contrastive_probe.js')
) {
  runContrastiveProbe();
}
