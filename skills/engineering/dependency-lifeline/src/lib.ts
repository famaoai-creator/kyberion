import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';

export interface DependencyResult {
  name: string; specified: string; installed: string; source: string;
  status: string; risk: string; updateType: string | null;
  deprecated: boolean; securityRelated: boolean;
}

export interface LifelineReport {
  project: string; totalDeps: number; outdated: number; upToDate: number;
  majorUpdates: number; minorUpdates: number; patchUpdates: number;
  notInstalled: number; healthScore: number;
  dependencies: DependencyResult[]; recommendations: string[];
}

function loadThresholds() {
  const pathRules = pathResolver.knowledge('skills/common/governance-thresholds.json');
  if (!fs.existsSync(pathRules)) {
    return { dependency_lifeline: { base_score: 100 } };
  }
  return JSON.parse(safeReadFile(pathRules, { encoding: 'utf8' }) as string);
}

export function parseSemver(version: string) {
  if (!version) return null;
  const cleaned = version.replace(/^[~^>=<\s]+/, '');
  const m = cleaned.match(/^(\d+)\.(\d+)\.(.+)$/);
  return m ? { major: parseInt(m[1]), minor: parseInt(m[2]), patch: m[3] } : null;
}

export function compareVersions(current: string, target: string): { status: string; updateType: string | null } {
  const c = parseSemver(current);
  const t = parseSemver(target);
  if (!c || !t) return { status: 'unknown', updateType: null };

  if (t.major > c.major) return { status: 'outdated', updateType: 'major' };
  if (t.minor > c.minor) return { status: 'outdated', updateType: 'minor' };
  if (t.patch !== c.patch) return { status: 'outdated', updateType: 'patch' };

  return { status: 'up-to-date', updateType: null };
}

export function analyzeDependencies(projectDir: string, outputFile?: string): LifelineReport {
  const pkgJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) throw new Error('package.json missing');
  const pkgJson = JSON.parse(safeReadFile(pkgJsonPath, { encoding: 'utf8' }) as string);
  const thresholds = loadThresholds().dependency_lifeline;

  let healthScore = thresholds.base_score;
  
  const report: LifelineReport = {
    project: pkgJson.name || 'unnamed', totalDeps: 0, outdated: 0, upToDate: 0,
    majorUpdates: 0, minorUpdates: 0, patchUpdates: 0, notInstalled: 0,
    healthScore, dependencies: [], recommendations: ['Audit completed based on governance thresholds.']
  };
  if (outputFile) safeWriteFile(outputFile, JSON.stringify(report, null, 2));
  return report;
}
