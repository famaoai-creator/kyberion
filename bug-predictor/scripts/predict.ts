/**
 * TypeScript version of the bug-predictor skill.
 *
 * Analyses git churn data and source-code complexity to identify
 * high-risk "bug hotspot" files in a repository.
 *
 * The CLI entry point remains in predict.cjs; this module exports
 * typed helper functions for the core prediction logic.
 *
 * Usage:
 *   import { getChurnData, estimateComplexity, buildReport } from './predict.js';
 *   const churn  = getChurnData('/path/to/repo', '3 months ago');
 *   const report = buildReport(churn, '/path/to/repo', 10);
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of file path to number of times it was changed (churn count). */
export type ChurnMap = Record<string, number>;

/** Complexity metrics for a single source file. */
export interface ComplexityMetrics {
  lines: number;
  complexity: number;
}

/** A single hotspot entry in the bug-predictor report. */
export interface Hotspot {
  file: string;
  churn: number;
  lines: number;
  complexity: number;
  riskScore: number;
}

/** Risk level summary counts. */
export interface RiskSummary {
  high: number;
  medium: number;
  low: number;
}

/** Full bug-predictor report. */
export interface PredictionReport {
  repository: string;
  since: string;
  totalFilesAnalyzed: number;
  hotspots: Hotspot[];
  riskSummary: RiskSummary;
  recommendation: string;
}

/** Options controlling the prediction analysis. */
export interface PredictOptions {
  /** Number of hotspots to include in the report (default: 10). */
  top?: number;
  /** Git log --since value (default: '3 months ago'). */
  since?: string;
  /** Optional output file path to write the JSON report. */
  outPath?: string;
}

// ---------------------------------------------------------------------------
// Regex for source-file extension filtering
// ---------------------------------------------------------------------------

/** Extensions considered as source code files. */
const SOURCE_EXTENSIONS: RegExp = /\.(js|ts|cjs|mjs|py|java|go|rs|rb|php|c|cpp|h)$/;

// ---------------------------------------------------------------------------
// Git churn analysis
// ---------------------------------------------------------------------------

/**
 * Collect churn data (number of commits per file) from the git log.
 *
 * @param dir   - Absolute path to the git repository
 * @param since - Git --since filter string (e.g. '3 months ago')
 * @returns Map of file path to commit count
 * @throws {Error} If git analysis fails (e.g. not a git repository)
 */
export function getChurnData(dir: string, since: string): ChurnMap {
  try {
    const output = execSync(`git log --since="${since}" --name-only --pretty=format: -- .`, {
      encoding: 'utf8',
      cwd: dir,
      timeout: 15_000,
      stdio: 'pipe',
    });
    const files = output.split('\n').filter((f) => f.trim().length > 0);
    const churn: ChurnMap = {};
    for (const file of files) {
      churn[file] = (churn[file] ?? 0) + 1;
    }
    return churn;
  } catch (err) {
    throw new Error(`Git analysis failed: ${(err as Error).message}. Is this a git repository?`);
  }
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cyclomatic-style complexity of a source file using simple
 * heuristic pattern matching.
 *
 * @param filePath - Relative path to the file (relative to dir)
 * @param dir      - Absolute path to the repository root
 * @returns Complexity metrics (lines and complexity score)
 */
export function estimateComplexity(filePath: string, dir: string): ComplexityMetrics {
  const fullPath = path.resolve(dir, filePath);
  if (!fs.existsSync(fullPath)) return { lines: 0, complexity: 0 };

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n').length;

    let complexity = 0;
    complexity += (content.match(/if\s*\(/g) ?? []).length;
    complexity += (content.match(/else\s/g) ?? []).length;
    complexity += (content.match(/for\s*\(/g) ?? []).length;
    complexity += (content.match(/while\s*\(/g) ?? []).length;
    complexity += (content.match(/switch\s*\(/g) ?? []).length;
    complexity += (content.match(/catch\s*\(/g) ?? []).length;
    complexity += (content.match(/\?\s/g) ?? []).length; // ternary

    return { lines, complexity };
  } catch {
    return { lines: 0, complexity: 0 };
  }
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

/**
 * Calculate a normalised risk score from churn count, complexity, and line count.
 *
 * Risk = churn * (1 + complexity_density), capped at 100.
 *
 * @param churn      - Number of commits touching the file
 * @param complexity - Estimated cyclomatic complexity
 * @param lines      - Total lines of code
 * @returns Risk score (0-100)
 */
export function calculateRiskScore(churn: number, complexity: number, lines: number): number {
  const complexityDensity = lines > 0 ? (complexity / lines) * 100 : 0;
  const rawScore = churn * (1 + complexityDensity);
  return Math.min(Math.round(rawScore * 10) / 10, 100);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build the full prediction report from churn data.
 *
 * @param churnData - Map of file path to churn count
 * @param repoDir   - Absolute path to the repository root
 * @param options   - Analysis options
 * @returns Prediction report
 */
export function buildReport(
  churnData: ChurnMap,
  repoDir: string,
  options: PredictOptions = {}
): PredictionReport {
  const top = options.top ?? 10;
  const since = options.since ?? '3 months ago';

  const sourceFiles: Hotspot[] = Object.entries(churnData)
    .filter(([file]) => SOURCE_EXTENSIONS.test(file))
    .map(([file, churn]) => {
      const { lines, complexity } = estimateComplexity(file, repoDir);
      const riskScore = calculateRiskScore(churn, complexity, lines);
      return { file, churn, lines, complexity, riskScore };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, top);

  const riskSummary: RiskSummary = { high: 0, medium: 0, low: 0 };
  for (const f of sourceFiles) {
    if (f.riskScore >= 30) riskSummary.high++;
    else if (f.riskScore >= 10) riskSummary.medium++;
    else riskSummary.low++;
  }

  const recommendation =
    riskSummary.high > 0
      ? `${riskSummary.high} high-risk file(s) detected. Consider adding tests and refactoring.`
      : 'No critical risk hotspots found.';

  return {
    repository: repoDir,
    since,
    totalFilesAnalyzed: Object.keys(churnData).length,
    hotspots: sourceFiles,
    riskSummary,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Skill execution
// ---------------------------------------------------------------------------

/**
 * Run the full bug-predictor analysis pipeline.
 *
 * @param repoDir - Absolute path to the repository
 * @param options - Analysis options
 * @returns Prediction report
 */
export function predict(repoDir: string, options: PredictOptions = {}): PredictionReport {
  const since = options.since ?? '3 months ago';
  const churnData = getChurnData(repoDir, since);
  const report = buildReport(churnData, repoDir, options);

  if (options.outPath) {
    fs.writeFileSync(options.outPath, JSON.stringify(report, null, 2));
  }

  return report;
}

/**
 * Build a SkillOutput envelope for the bug-predictor skill.
 *
 * @param report  - Prediction report data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildPredictOutput(
  report: PredictionReport,
  startMs: number
): SkillOutput<PredictionReport> {
  return {
    skill: 'bug-predictor',
    status: 'success',
    data: report,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
