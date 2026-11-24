#!/usr/bin/env node
/**
 * Pipeline Catalog Dry-Run Gate
 *
 * Sweeps every catalog pipeline ADF and reports each file's dry-run verdict.
 * Fails when an executable-claiming file assesses `blocked` — the failure a
 * user would hit at dispatch time (unknown op, broken channel flow,
 * unresolvable include) instead of at run time.
 *
 * Sweep scope (the pre-trust executable surfaces):
 *   pipelines/*.json, pipelines/config/*.json,
 *   knowledge/product/pipeline-templates/*.json
 *
 * Files that intentionally do not claim executability declare
 * "_execution_status": "reference" (+ "_execution_note"); they are listed
 * but exempt. A missing note fails the exemption — the marker must say why.
 *
 * Determinism: provider capability state is host-specific, so the sweep
 * passes providerSnapshot: null — a missing snapshot degrades provider
 * checks to warnings and can never block the gate.
 */

import { assessPipelineDryRun } from '@agent/core/pipeline/pipeline-dry-run';
import { validatePipelineAdf } from '@agent/core/pipeline/pipeline-contract';
import { pathResolver } from '@agent/core/path-resolver';
import { isRecord } from '@agent/core/foundation';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { readSafeJsonFile } from '../lib/json-input.js';
import { expandPipelineIncludesForDryRun } from '../refactor/adf-input.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

const SCAN_DIRS = ['pipelines', 'pipelines/config', 'knowledge/product/pipeline-templates'];

interface SweepEntry {
  file: string;
  verdict: 'ready' | 'warning' | 'blocked' | 'reference' | 'invalid';
  messages: string[];
}

function listPipelineJson(dirRepoPath: string): string[] {
  const absolute = pathResolver.rootResolve(dirRepoPath);
  if (!safeExistsSync(absolute)) return [];
  return safeReaddir(absolute)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => `${dirRepoPath}/${entry}`);
}

export function sweepPipelineCatalog(): SweepEntry[] {
  const entries: SweepEntry[] = [];
  for (const dir of SCAN_DIRS) {
    for (const repoPath of listPipelineJson(dir)) {
      const absolute = pathResolver.rootResolve(repoPath);
      let parsed: unknown;
      try {
        parsed = readSafeJsonFile<unknown>(absolute, repoPath);
      } catch (error) {
        entries.push({
          file: repoPath,
          verdict: 'invalid',
          messages: [error instanceof Error ? error.message : String(error)],
        });
        continue;
      }
      entries.push(assessCatalogEntry(repoPath, parsed));
    }
  }
  return entries;
}

/**
 * Verdict for one parsed pipeline document. A `reference` exemption only holds
 * when a non-empty `_execution_note` explains the status — without it the file
 * is `invalid` (the note IS the exemption, so a missing note must fail rather
 * than silently pass).
 */
export function assessCatalogEntry(file: string, parsed: unknown): SweepEntry {
  if (isRecord(parsed) && parsed._execution_status === 'reference') {
    const note = typeof parsed._execution_note === 'string' ? parsed._execution_note.trim() : '';
    return note
      ? { file, verdict: 'reference', messages: [note] }
      : {
          file,
          verdict: 'invalid',
          messages: ['_execution_status: reference requires a non-empty _execution_note'],
        };
  }
  try {
    const pipeline = validatePipelineAdf(parsed);
    const expanded = expandPipelineIncludesForDryRun(pipeline, { trustResolved: true });
    const report = assessPipelineDryRun(expanded, { providerSnapshot: null });
    return {
      file,
      verdict: report.verdict,
      messages: report.checks
        .filter((check) => check.status !== 'pass')
        .map((check) => `${check.id}: ${check.message}`),
    };
  } catch (error) {
    return {
      file,
      verdict: 'invalid',
      messages: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function formatSweepReport(entries: SweepEntry[]): string {
  const counts = { ready: 0, warning: 0, blocked: 0, reference: 0, invalid: 0 };
  for (const entry of entries) counts[entry.verdict] += 1;
  const lines = [
    `pipeline catalog dry-run: ${entries.length} file(s) — ` +
      `ready ${counts.ready}, warning ${counts.warning}, reference ${counts.reference}, ` +
      `blocked ${counts.blocked}, invalid ${counts.invalid}`,
  ];
  for (const entry of entries) {
    if (entry.verdict === 'ready') continue;
    lines.push(`- ${entry.verdict}: ${entry.file}`);
    for (const message of entry.messages.slice(0, 6)) lines.push(`    ${message}`);
  }
  return lines.join('\n');
}

export const runCheckPipelineDryRun = defineScript({
  name: 'check:pipeline-dry-run',
  flags: [],
  run(context) {
    const entries = sweepPipelineCatalog();
    const report = formatSweepReport(entries);
    const failures = entries.filter(
      (entry) => entry.verdict === 'blocked' || entry.verdict === 'invalid'
    );
    if (failures.length > 0) {
      context.print('[check:pipeline-dry-run] FAILED');
      for (const line of report.split('\n')) context.print(line);
      throw new ScriptExitError(1);
    }
    context.print(`[check:pipeline-dry-run] OK (${report.split('\n')[0]})`);
    return { entries };
  },
});

if (
  isDirectScript(import.meta.url, 'check_pipeline_dry_run.ts') ||
  isDirectScript(import.meta.url, 'check_pipeline_dry_run.js')
)
  void runCheckPipelineDryRun();
