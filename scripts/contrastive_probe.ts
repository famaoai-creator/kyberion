/**
 * contrastive_probe — run the harness2 Propose-Probe-Compose loop for a
 * repeating work shape. Candidates come from --candidate overlays and/or the
 * --propose LLM stage; every overlay is surface-validated, probed on the same
 * scenario, and classified on the decision axis. --select blind adds an
 * anonymized recommendation when the axis routes to human_gate.
 */

import { runContrastiveSession } from '@agent/core/harnessing/contrastive-session';
import type { MetricSpec } from '@agent/core/harnessing/decision-axis';
import { loadSurfaceSpec } from '@agent/core/harnessing/surface-spec';
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

const USAGE =
  'Usage: contrastive_probe --scenario <dir> --run-root <dir> --command "<argv>" ' +
  '[--candidate <label>=<dir> | --propose <n> --brief <text> --surface <spec.json>] ' +
  '[--expect <rel>] [--metric <key>:lower|higher] [--select blind] ' +
  '[--seed <n>] [--work-shape <name>]';

function parseSeed(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new ScriptExitError(2, `--seed expects a non-negative integer, got ${raw}`);
  }
  return n;
}

export const runContrastiveProbe = defineScript({
  name: 'contrastive_probe',
  run: async (context: { argv: string[]; print: (line: string) => void }) => {
    const args = parseArgs(context.argv);
    const scenario = args['scenario']?.[0];
    const runRoot = args['run-root']?.[0];
    const commandRaw = args['command']?.[0];
    if (!scenario || !runRoot || !commandRaw) {
      throw new ScriptExitError(2, USAGE);
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
      if (!key) {
        throw new ScriptExitError(2, `--metric expects a non-empty key, got ${m}`);
      }
      if (dir !== 'lower' && dir !== 'higher') {
        throw new ScriptExitError(2, `--metric expects <key>:lower|higher, got ${m}`);
      }
      return { key, direction: dir };
    });
    const proposeCount = args['propose']?.[0] ? Number(args['propose'][0]) : 0;
    if (
      args['propose']?.[0] &&
      (!Number.isFinite(proposeCount) || proposeCount < 1 || !Number.isInteger(proposeCount))
    ) {
      throw new ScriptExitError(
        2,
        `--propose expects a positive integer, got ${args['propose'][0]}`
      );
    }
    if (proposeCount > 0 && !args['brief']?.[0]) {
      throw new ScriptExitError(2, '--propose requires --brief <text>');
    }
    const surface = args['surface']?.[0] ? loadSurfaceSpec(args['surface'][0]) : undefined;
    if (proposeCount > 0 && !surface) {
      throw new ScriptExitError(2, '--propose requires --surface <spec.json>');
    }
    const selectArg = args['select']?.[0];
    if (selectArg && selectArg !== 'blind') {
      throw new ScriptExitError(2, `--select expects blind, got ${selectArg}`);
    }
    const select = selectArg as 'blind' | undefined;
    const command = commandRaw.split(/\s+/).filter(Boolean);
    const result = await runContrastiveSession({
      session_id: `ppc-${Date.now().toString(36)}`,
      scenarioDir: scenario,
      command,
      candidates,
      ...(proposeCount > 0 ? { propose: { brief: args['brief']![0], count: proposeCount } } : {}),
      ...(surface ? { surface } : {}),
      ...(select ? { selection: select } : {}),
      ...(args['seed']?.[0] ? { seed: parseSeed(args['seed'][0]) } : {}),
      expectOutputs: args['expect'] ?? [],
      metrics,
      runRoot,
      work_shape: args['work-shape']?.[0],
    });
    console.log(
      JSON.stringify(
        { decision: result.decision, selection: result.selection?.recommended_winner ?? null },
        null,
        2
      )
    );
    console.log(`report: ${result.report_path}`);
  },
});

if (
  isDirectScript(import.meta.url, 'contrastive_probe.ts') ||
  isDirectScript(import.meta.url, 'contrastive_probe.js')
) {
  runContrastiveProbe();
}
