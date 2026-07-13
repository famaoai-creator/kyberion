import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';

/**
 * LC-09 follow-up: persist per-run llm_decide degradation counts so the
 * operator packet (a different process from run_pipeline) can aggregate them.
 * Rolling window, size-capped — this is observability, not an audit record.
 */

export interface SemanticDegradationRun {
  at: string;
  pipeline_id: string;
  counts: Record<string, number>;
  total: number;
}

const LOG_RELATIVE_PATH = 'active/shared/runtime/feedback-loop/semantic-degradations.json';
const MAX_RUNS = 200;

function logPath(): string {
  return pathResolver.rootResolve(LOG_RELATIVE_PATH);
}

function readRuns(): SemanticDegradationRun[] {
  try {
    const filePath = logPath();
    if (!safeExistsSync(filePath)) return [];
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendSemanticDegradationRun(
  pipelineId: string,
  counts: Record<string, number>
): void {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total === 0) return;
  try {
    const filePath = logPath();
    safeMkdir(path.dirname(filePath), { recursive: true });
    const runs = readRuns();
    runs.push({ at: new Date().toISOString(), pipeline_id: pipelineId, counts, total });
    safeWriteFile(filePath, `${JSON.stringify(runs.slice(-MAX_RUNS), null, 2)}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[semantic-degradation-log] append failed: ${detail}`);
  }
}

export interface SemanticDegradationSummary {
  runs: number;
  total: number;
  by_reason: Record<string, number>;
  top_pipelines: Array<{ pipeline_id: string; total: number }>;
}

export function summarizeSemanticDegradations(options: {
  sinceMs: number;
}): SemanticDegradationSummary {
  const cutoff = Date.now() - options.sinceMs;
  const runs = readRuns().filter((run) => Date.parse(run.at) >= cutoff);
  const byReason: Record<string, number> = {};
  const byPipeline: Record<string, number> = {};
  let total = 0;
  for (const run of runs) {
    total += run.total;
    byPipeline[run.pipeline_id] = (byPipeline[run.pipeline_id] || 0) + run.total;
    for (const [reason, count] of Object.entries(run.counts)) {
      byReason[reason] = (byReason[reason] || 0) + count;
    }
  }
  const topPipelines = Object.entries(byPipeline)
    .map(([pipeline_id, pipelineTotal]) => ({ pipeline_id, total: pipelineTotal }))
    .sort((left, right) => right.total - left.total)
    .slice(0, 3);
  return { runs: runs.length, total, by_reason: byReason, top_pipelines: topPipelines };
}
