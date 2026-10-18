/**
 * contrastive_probe — run the harness2 Propose-Probe-Compose loop for a
 * repeating work shape. Candidates come from --candidate overlays and/or the
 * --propose LLM stage; every overlay is surface-validated, probed on the same
 * scenario, and classified on the decision axis. --select blind adds an
 * anonymized recommendation when the axis routes to human_gate.
 */

import { runContrastiveSession } from '@agent/core/harnessing/contrastive-session';
import { runRecursiveSession } from '@agent/core/harnessing/recursive-session';
import type { MetricSpec } from '@agent/core/harnessing/decision-axis';
import { loadSurfaceSpec } from '@agent/core/harnessing/surface-spec';
import { loadProbeScenario } from '@agent/core/harnessing/eval-scenario';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new ScriptExitError(
        2,
        `unexpected positional argument ${JSON.stringify(a)} — quote multi-word values`
      );
    }
    const key = a.slice(2);
    if (key.includes('=')) {
      throw new ScriptExitError(
        2,
        `--${key}: --flag=value form is not supported; pass the value as a separate argument`
      );
    }
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null;
    if (val === null) {
      throw new ScriptExitError(2, `--${key} requires a value`);
    }
    (out[key] ??= []).push(val);
  }
  return out;
}

const USAGE =
  'Usage: contrastive_probe (--scenario <dir> --command "<argv>" | --scenario-spec <spec.json>) ' +
  '--run-root <dir> ' +
  '[--candidate <label>=<dir> | --propose <n> --brief <text> --surface <spec.json> ' +
  '[--library <root> --domain <name>]] ' +
  '[--expect <rel>] [--metric <key>:lower|higher] [--select blind] [--markers <a,b,c>] ' +
  '[--seed <n>] [--rounds <n>] [--work-shape <name>]';

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
    const args = parseArgs(stripSharedScriptFlags(context.argv));
    const KNOWN = new Set([
      'scenario',
      'command',
      'scenario-spec',
      'run-root',
      'candidate',
      'propose',
      'brief',
      'surface',
      'select',
      'seed',
      'expect',
      'metric',
      'work-shape',
      'rounds',
      'library',
      'domain',
      'markers',
    ]);
    for (const key of Object.keys(args)) {
      if (!KNOWN.has(key)) {
        throw new ScriptExitError(2, `unknown flag --${key}`);
      }
    }
    for (const key of [
      'scenario',
      'command',
      'scenario-spec',
      'run-root',
      'propose',
      'brief',
      'surface',
      'select',
      'seed',
      'rounds',
      'library',
      'domain',
      'work-shape',
    ]) {
      if ((args[key]?.length ?? 0) > 1) {
        throw new ScriptExitError(
          2,
          `--${key} given ${args[key].length} times — scalar flags accept one value`
        );
      }
    }
    const scenario = args['scenario']?.[0];
    const scenarioSpecPath = args['scenario-spec']?.[0];
    const runRoot = args['run-root']?.[0];
    const commandRaw = args['command']?.[0];
    if (!runRoot || (!scenarioSpecPath && (!scenario || !commandRaw))) {
      throw new ScriptExitError(2, USAGE);
    }
    if ((scenario || commandRaw) && scenarioSpecPath) {
      throw new ScriptExitError(
        2,
        '--scenario/--command and --scenario-spec are mutually exclusive'
      );
    }
    // --scenario-spec wraps an eval fixture as {workspace_dir, command,
    // expect_outputs}; --expect appends on top of the spec's expectations.
    const probeScenario = scenarioSpecPath ? loadProbeScenario(scenarioSpecPath) : null;
    const scenarioDir = probeScenario ? probeScenario.scenarioDir : scenario!;
    const expectOutputs = [...(probeScenario?.expectOutputs ?? []), ...(args['expect'] ?? [])];
    const candidates = (args['candidate'] ?? []).map((entry) => {
      const eq = entry.indexOf('=');
      if (eq < 0) {
        throw new ScriptExitError(2, `--candidate expects <label>=<overlay-dir>, got ${entry}`);
      }
      return { label: entry.slice(0, eq), overlayDir: entry.slice(eq + 1) };
    });
    const metrics: MetricSpec[] = (args['metric'] ?? []).map((m) => {
      const parts = m.split(':');
      const [key, dir] = parts;
      if (!key || parts.length !== 2) {
        throw new ScriptExitError(2, `--metric expects key:higher|lower, got ${m}`);
      }
      if (dir !== 'lower' && dir !== 'higher') {
        throw new ScriptExitError(2, `--metric expects <key>:lower|higher, got ${m}`);
      }
      return { key, direction: dir };
    });
    const proposeCount = args['propose']?.[0] ? Number(args['propose'][0]) : 0;
    if (
      args['propose']?.[0] &&
      (!Number.isFinite(proposeCount) ||
        proposeCount < 1 ||
        proposeCount > 10 ||
        !Number.isInteger(proposeCount))
    ) {
      throw new ScriptExitError(2, `--propose expects an integer 1..10, got ${args['propose'][0]}`);
    }
    if (proposeCount > 0 && !args['brief']?.[0]) {
      throw new ScriptExitError(2, '--propose requires --brief <text>');
    }
    const surface = args['surface']?.[0] ? loadSurfaceSpec(args['surface'][0]) : undefined;
    if (proposeCount > 0 && !surface) {
      throw new ScriptExitError(2, '--propose requires --surface <spec.json>');
    }
    // --library/--domain seed the propose prompt from the domain's prior
    // lessons; both halves are required and they only apply to --propose.
    const libraryRoot = args['library']?.[0];
    const libraryDomain = args['domain']?.[0];
    if (Boolean(libraryRoot) !== Boolean(libraryDomain)) {
      throw new ScriptExitError(2, '--library and --domain must be given together');
    }
    if (libraryRoot && proposeCount === 0) {
      throw new ScriptExitError(2, '--library/--domain only apply with --propose');
    }
    const library = libraryRoot ? { root: libraryRoot, domain: libraryDomain! } : undefined;
    // --markers a,b,c extends the leak-tripwire default marker list.
    const extraMarkers = (args['markers'] ?? [])
      .flatMap((m) => m.split(','))
      .map((m) => m.trim())
      .filter(Boolean);
    const markers = extraMarkers.length ? extraMarkers : undefined;
    const selectArg = args['select']?.[0];
    if (selectArg && selectArg !== 'blind') {
      throw new ScriptExitError(2, `--select expects blind, got ${selectArg}`);
    }
    const select = selectArg as 'blind' | undefined;
    const command = probeScenario
      ? probeScenario.command
      : commandRaw!.split(/\s+/).filter(Boolean);
    const rounds = args['rounds']?.[0] ? Number(args['rounds'][0]) : 1;
    if (args['rounds']?.[0] && (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)) {
      throw new ScriptExitError(2, `--rounds expects an integer 1..10, got ${args['rounds'][0]}`);
    }
    if (rounds > 1) {
      const rec = await runRecursiveSession({
        session_id: `ppc-${Date.now().toString(36)}`,
        scenarioDir,
        command,
        candidates,
        ...(proposeCount > 0
          ? {
              propose: {
                brief: args['brief']![0],
                count: proposeCount,
                ...(library ? { library } : {}),
              },
            }
          : {}),
        ...(surface ? { surface } : {}),
        ...(markers ? { markers } : {}),
        ...(select ? { selection: select } : {}),
        ...(args['seed']?.[0] ? { seed: parseSeed(args['seed'][0]) } : {}),
        rounds,
        expectOutputs,
        metrics,
        runRoot,
        work_shape: args['work-shape']?.[0],
      });
      context.print(
        JSON.stringify(
          {
            final: rec.final_decision.decision,
            halted_by: rec.halted_by,
            budget: rec.budget,
            adopted: rec.adopted_overlays,
          },
          null,
          2
        )
      );
      context.print(`report: ${rec.report_path}`);
      return;
    }
    const result = await runContrastiveSession({
      session_id: `ppc-${Date.now().toString(36)}`,
      scenarioDir,
      command,
      candidates,
      ...(proposeCount > 0
        ? {
            propose: {
              brief: args['brief']![0],
              count: proposeCount,
              ...(library ? { library } : {}),
            },
          }
        : {}),
      ...(surface ? { surface } : {}),
      ...(markers ? { markers } : {}),
      ...(select ? { selection: select } : {}),
      ...(args['seed']?.[0] ? { seed: parseSeed(args['seed'][0]) } : {}),
      expectOutputs,
      metrics,
      runRoot,
      work_shape: args['work-shape']?.[0],
    });
    context.print(
      JSON.stringify(
        { decision: result.decision, selection: result.selection?.recommended_winner ?? null },
        null,
        2
      )
    );
    context.print(`report: ${result.report_path}`);
  },
});

if (
  isDirectScript(import.meta.url, 'contrastive_probe.ts') ||
  isDirectScript(import.meta.url, 'contrastive_probe.js')
) {
  runContrastiveProbe();
}
