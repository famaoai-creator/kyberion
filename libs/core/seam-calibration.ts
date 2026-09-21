/**
 * Seam calibration — run the same task on every candidate provider of a seam
 * and write a side-by-side report a human can judge.
 *
 * This is the fallback when no selection rule is known: instead of guessing
 * trait values, the operator runs a calibration, looks at the outputs and
 * measurements, and then records a rule (`kyberion seam select rules set`) and/or the
 * measured trait values (`kyberion seam select apply-measurements`), both stored in
 * the operator overlay (seam-selection-rules.ts).
 *
 * Each seam contributes an adapter: how to list candidates for an input, how
 * to run one trial, and which measured metrics map to which policy traits.
 */

import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { SeamProviderCandidate } from './seam-provider-selection.js';

export interface SeamCalibrationTrialOutput {
  /** Text output (transcript, OCR text, ...) shown in the report. */
  text?: string;
  /** Artifact written by the trial (audio, image, video, ...). */
  artifact_path?: string;
}

export interface SeamCalibrationTrialResult {
  ok: boolean;
  output?: SeamCalibrationTrialOutput;
  /** Adapter-specific measurements (e.g. char_error_rate, bytes). */
  metrics?: Record<string, number>;
  error?: string;
}

export interface SeamCalibrationTrialContext {
  /** Directory for this provider's artifacts in this run. */
  outDir: string;
  repeat: number;
}

/** How a measured metric turns into a 0..1 policy trait across providers. */
export interface SeamCalibrationTraitMapping {
  metric: string;
  higher_is_better: boolean;
}

export interface SeamCalibrationAdapter<TInput = Record<string, unknown>> {
  seam: string;
  description: string;
  /** Shape of the --input JSON, shown by the CLI. */
  input_example: TInput;
  /** Candidates for this input (eligibility = can run it here and now). */
  listCandidates(input: TInput): Promise<SeamProviderCandidate[]>;
  runTrial(
    providerId: string,
    input: TInput,
    context: SeamCalibrationTrialContext
  ): Promise<SeamCalibrationTrialResult>;
  /**
   * Policy trait → metric used to suggest measured trait values. The runner
   * always measures `latency_ms`; default mapping: { speed: latency_ms ↓ }.
   * Use the seam policy's trait names (e.g. `latency` for STT / OCR).
   */
  trait_mappings?: Record<string, SeamCalibrationTraitMapping>;
  /**
   * Providers that cost money or send data off-machine; they only run when the
   * operator lists them explicitly (--providers).
   */
  requiresExplicitOptIn?(providerId: string): boolean;
}

export interface SeamCalibrationProviderSummary {
  provider_id: string;
  eligible: boolean;
  unmet?: string[];
  skipped_reason?: string;
  runs: Array<SeamCalibrationTrialResult & { latency_ms: number }>;
  success_rate: number;
  latency_ms_median?: number;
  metrics_mean: Record<string, number>;
}

export interface SeamCalibrationReport {
  seam: string;
  run_id: string;
  created_at: string;
  input: unknown;
  repeats: number;
  providers: SeamCalibrationProviderSummary[];
  /** trait → provider → suggested measured value (0..1, min-max across providers). */
  suggested_traits: Record<string, Record<string, number>>;
  report_json: string;
  report_markdown: string;
}

const adapters = new Map<string, SeamCalibrationAdapter<any>>();

export function registerSeamCalibrationAdapter<T>(adapter: SeamCalibrationAdapter<T>): () => void {
  adapters.set(adapter.seam, adapter as SeamCalibrationAdapter<any>);
  return () => {
    if (adapters.get(adapter.seam) === (adapter as SeamCalibrationAdapter<any>)) {
      adapters.delete(adapter.seam);
    }
  };
}

export function getSeamCalibrationAdapter(seam: string): SeamCalibrationAdapter<any> | null {
  return adapters.get(seam) ?? null;
}

export function listSeamCalibrationAdapters(): SeamCalibrationAdapter<any>[] {
  return [...adapters.values()].sort((a, b) => a.seam.localeCompare(b.seam));
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Min-max normalise one metric across providers into 0..1 trait values. */
export function suggestTraitValues(
  providers: SeamCalibrationProviderSummary[],
  mappings: Record<string, SeamCalibrationTraitMapping>
): Record<string, Record<string, number>> {
  const suggested: Record<string, Record<string, number>> = {};
  for (const [trait, mapping] of Object.entries(mappings)) {
    const values = providers
      .filter((p) => p.success_rate > 0)
      .map((p) => ({
        id: p.provider_id,
        value:
          mapping.metric === 'latency_ms' ? p.latency_ms_median : p.metrics_mean[mapping.metric],
      }))
      .filter((entry): entry is { id: string; value: number } => Number.isFinite(entry.value));
    if (values.length < 2) continue;
    const min = Math.min(...values.map((v) => v.value));
    const max = Math.max(...values.map((v) => v.value));
    suggested[trait] = {};
    for (const { id, value } of values) {
      const normalised = max === min ? 1 : (value - min) / (max - min);
      suggested[trait]![id] = round(mapping.higher_is_better ? normalised : 1 - normalised, 2);
    }
  }
  return suggested;
}

function renderMarkdown(report: Omit<SeamCalibrationReport, 'report_markdown'>): string {
  const lines: string[] = [
    `# Calibration: ${report.seam}`,
    '',
    `- run: \`${report.run_id}\` (${report.created_at}), repeats: ${report.repeats}`,
    `- input: \`${JSON.stringify(report.input).slice(0, 300)}\``,
    '',
    '| provider | eligible | success | median latency (ms) | metrics | output |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const p of report.providers) {
    const last = p.runs.find((run) => run.ok) ?? p.runs[p.runs.length - 1];
    const output = last?.output?.artifact_path
      ? `\`${last.output.artifact_path}\``
      : last?.output?.text
        ? last.output.text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 80)
        : (last?.error ?? p.skipped_reason ?? (p.unmet ?? []).join(', ')).slice(0, 80);
    const metrics = Object.entries(p.metrics_mean)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(
      `| ${p.provider_id} | ${p.eligible ? 'yes' : 'no'} | ${p.runs.length ? `${Math.round(p.success_rate * 100)}%` : '-'} | ${p.latency_ms_median ?? '-'} | ${metrics || '-'} | ${output || '-'} |`
    );
  }
  const traits = Object.entries(report.suggested_traits);
  lines.push('', '## Suggested measured traits', '');
  if (traits.length === 0) {
    lines.push('None (needs at least two providers with successful runs).');
  } else {
    for (const [trait, values] of traits) {
      lines.push(
        `- **${trait}**: ${Object.entries(values)
          .map(([id, value]) => `${id}=${value}`)
          .join(', ')}`
      );
    }
  }
  lines.push(
    '',
    '## Next steps (human decision)',
    '',
    `- Prefer providers for a purpose / context:`,
    `  \`pnpm kyberion seam select rules set --seam ${report.seam} --rule-id <id> --purpose <purpose> [--context key=value] --prefer <a,b> --evidence ${report.report_json}\``,
    `- Record the measured traits above:`,
    `  \`pnpm kyberion seam select apply-measurements --report ${report.report_json} [--traits ${traits.map(([t]) => t).join(',') || '<trait>'}]\``,
    `- Check the resulting choice: \`pnpm kyberion seam select explain --seam ${report.seam} --purpose <purpose>\``,
    ''
  );
  return lines.join('\n');
}

export function defaultCalibrationRoot(): string {
  const missionId = getMissionIdSafe();
  return missionId
    ? pathResolver.rootResolve(path.join('active/shared/runtime/seam-calibration', missionId))
    : pathResolver.rootResolve('active/shared/runtime/seam-calibration');
}

function getMissionIdSafe(): string | undefined {
  const value = getRegisteredEnvText('MISSION_ID')?.trim();
  return value && /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

export interface RunSeamCalibrationOptions {
  seam: string;
  input: unknown;
  /** Restrict to these providers; also the only way to include opt-in providers. */
  providers?: string[];
  repeats?: number;
  outRoot?: string;
  runId?: string;
  now?: () => number;
}

export async function runSeamCalibration(
  options: RunSeamCalibrationOptions
): Promise<SeamCalibrationReport> {
  const adapter = getSeamCalibrationAdapter(options.seam);
  if (!adapter) {
    throw new Error(
      `[SEAM_CALIBRATION] no calibration adapter for seam '${options.seam}' (have: ${listSeamCalibrationAdapters()
        .map((a) => a.seam)
        .join(', ')})`
    );
  }
  const now = options.now ?? (() => performance.now());
  const repeats = Math.max(1, Math.min(10, Math.floor(options.repeats ?? 1)));
  const runId = options.runId ?? `${options.seam}-${nowIso().replace(/[:.]/g, '-')}`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId))
    throw new Error(`[SEAM_CALIBRATION] invalid run id '${runId}'`);
  const runDir = path.join(options.outRoot ?? defaultCalibrationRoot(), options.seam, runId);
  if (!safeExistsSync(runDir)) safeMkdir(runDir, { recursive: true });

  const explicit = options.providers?.length ? new Set(options.providers) : null;
  const candidates = await adapter.listCandidates(options.input);
  const summaries: SeamCalibrationProviderSummary[] = [];
  for (const candidate of candidates) {
    const summary: SeamCalibrationProviderSummary = {
      provider_id: candidate.id,
      eligible: candidate.eligible,
      ...(candidate.unmet?.length ? { unmet: candidate.unmet } : {}),
      runs: [],
      success_rate: 0,
      metrics_mean: {},
    };
    summaries.push(summary);
    if (explicit && !explicit.has(candidate.id)) {
      summary.skipped_reason = 'not selected (--providers)';
      continue;
    }
    if (!candidate.eligible) continue;
    if (!explicit && adapter.requiresExplicitOptIn?.(candidate.id)) {
      summary.skipped_reason = 'costs money or leaves the machine; list it in --providers to run';
      continue;
    }
    const outDir = path.join(runDir, candidate.id.replace(/[^A-Za-z0-9._-]/g, '_'));
    if (!safeExistsSync(outDir)) safeMkdir(outDir, { recursive: true });
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const started = now();
      let result: SeamCalibrationTrialResult;
      try {
        result = await adapter.runTrial(candidate.id, options.input, { outDir, repeat });
      } catch (error: unknown) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      summary.runs.push({ ...result, latency_ms: Math.round(now() - started) });
    }
    const ok = summary.runs.filter((run) => run.ok);
    summary.success_rate = round(ok.length / summary.runs.length, 2);
    const latency = median(ok.map((run) => run.latency_ms));
    if (latency !== undefined) summary.latency_ms_median = latency;
    const metricKeys = new Set(ok.flatMap((run) => Object.keys(run.metrics ?? {})));
    for (const key of metricKeys) {
      const values = ok
        .map((run) => run.metrics?.[key])
        .filter((value): value is number => Number.isFinite(value));
      if (values.length)
        summary.metrics_mean[key] = round(values.reduce((a, b) => a + b, 0) / values.length);
    }
  }

  const mappings: Record<string, SeamCalibrationTraitMapping> = adapter.trait_mappings ?? {
    speed: { metric: 'latency_ms', higher_is_better: false },
  };
  const reportJson = path.join(runDir, 'report.json');
  const reportMarkdown = path.join(runDir, 'report.md');
  const base = {
    seam: options.seam,
    run_id: runId,
    created_at: nowIso(),
    input: options.input,
    repeats,
    providers: summaries,
    suggested_traits: suggestTraitValues(summaries, mappings),
    report_json: pathResolver.toRepoRelative(reportJson),
  };
  const markdown = renderMarkdown(base);
  const report: SeamCalibrationReport = {
    ...base,
    report_markdown: pathResolver.toRepoRelative(reportMarkdown),
  };
  safeWriteFile(reportJson, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
  safeWriteFile(reportMarkdown, markdown, { encoding: 'utf8' });
  return report;
}
