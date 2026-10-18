#!/usr/bin/env node
/**
 * contrastive_probe — run the harness2 Propose-Probe-Compose probe stage for a
 * repeating work shape. Candidates are supplied as overlay directories
 * (propose-from-scratch is a follow-on); this executes them on the same
 * scenario, classifies the evidence on the decision axis, and writes a report.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/contrastive_probe.ts \
 *     --scenario <base-dir> --candidate <label>=<overlay-dir> [--candidate ...] \
 *     --command <cmd argv, comma- or space-separated> \
 *     [--expect <rel-path>]... [--metric <key>:lower|higher]... \
 *     --run-root <dir> [--work-shape <name>]
 */

import { runContrastiveSession } from '../libs/core/harnessing/contrastive-session.js';
import type { MetricSpec } from '../libs/core/harnessing/decision-axis.js';

function parseArgs(argv: string[]) {
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

const args = parseArgs(process.argv.slice(2));
const scenario = args['scenario']?.[0];
const runRoot = args['run-root']?.[0];
const commandRaw = args['command']?.[0];
if (!scenario || !runRoot || !commandRaw) {
  console.error(
    'Usage: contrastive_probe --scenario <dir> --candidate <label>=<dir> [--candidate ...] --command "<argv>" --run-root <dir> [--expect <rel>] [--metric <key>:lower|higher] [--work-shape <name>]'
  );
  process.exit(2);
}
const candidates = (args['candidate'] ?? []).map((entry) => {
  const eq = entry.indexOf('=');
  if (eq < 0) throw new Error(`--candidate expects <label>=<overlay-dir>, got ${entry}`);
  return { label: entry.slice(0, eq), overlayDir: entry.slice(eq + 1) };
});
const metrics: MetricSpec[] = (args['metric'] ?? []).map((m) => {
  const [key, dir] = m.split(':');
  return { key, direction: dir === 'lower' ? 'lower' : 'higher' };
});
const command = commandRaw.includes(',') ? commandRaw.split(',') : commandRaw.split(' ');

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
