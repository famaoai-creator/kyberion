import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getAllFiles } from '@agent/core/fs-utils';
import { RiskEntry, TechStackInfo, Severity } from '@agent/core/shared-business-types';

export interface CodeQualityStats {
  totalFiles: number;
  totalLines: number;
  avgFileSize: number;
  languages: Record<string, number>;
}

export interface Contributor {
  commits: number;
  name: string;
}

export interface TeamMaturity {
  contributors: number;
  topContributors: Contributor[];
  busFactor: number;
  risk: 'critical' | 'high' | 'low' | 'unknown';
}

export interface ArchitectureSignals extends TechStackInfo {
  hasMonorepo: boolean;
  hasMicroservices: boolean;
  hasDockerCompose: boolean;
  hasTerraform: boolean;
  hasK8s: boolean;
  testFramework: string;
  cicd: string;
}

/**
 * Technical DD risk, compliant with shared RiskEntry.
 */
export interface DDRisk extends RiskEntry {
  area: string;
}

export interface DDResult {
  directory: string;
  score: number;
  verdict: 'strong_pass' | 'pass' | 'conditional_pass' | 'fail';
  codeQuality: CodeQualityStats;
  teamMaturity: TeamMaturity;
  architecture: ArchitectureSignals;
  risks: DDRisk[];
  recommendations: string[];
}

export function assessCodeQuality(dir: string): CodeQualityStats {
  let totalFiles = 0;
  let totalLines = 0;
  const languages: Record<string, number> = {};
  const allFiles = getAllFiles(dir, { maxDepth: 5 });

  const targetExts = ['.js', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb'];

  for (const full of allFiles) {
    const ext = path.extname(full).toLowerCase();
    if (targetExts.includes(ext)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        totalLines += content.split('\n').length;
        totalFiles++;
        languages[ext] = (languages[ext] || 0) + 1;
      } catch (_e) {
        /* ignore */
      }
    }
  }

  return {
    totalFiles,
    totalLines,
    avgFileSize: totalFiles > 0 ? Math.round(totalLines / totalFiles) : 0,
    languages,
  };
}

export function assessTeamMaturity(dir: string): TeamMaturity {
  try {
    const authors = execSync(
      'git log --format="%an" --since="6 months ago" | sort | uniq -c | sort -rn',
      { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const contributors: Contributor[] = authors
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const m = l.trim().match(/(\d+)\s+(.+)/);
        return m ? { commits: parseInt(m[1]), name: m[2] } : null;
      })
      .filter((c): c is Contributor => c !== null);

    const totalCommits = contributors.reduce((s, c) => s + c.commits, 0);
    const busFactorThreshold = totalCommits * 0.5;
    let busFactor = 0;
    let acc = 0;
    for (const c of contributors) {
      acc += c.commits;
      busFactor++;
      if (acc >= busFactorThreshold) break;
    }

    const topContributorShare =
      totalCommits > 0 ? Math.round((contributors[0].commits / totalCommits) * 100) : 0;

    let risk: TeamMaturity['risk'] = 'low';
    if (busFactor <= 1 || topContributorShare > 70) risk = 'critical';
    else if (busFactor <= 2 || topContributorShare > 50) risk = 'high';

    return {
      contributors: contributors.length,
      topContributors: contributors.slice(0, 5),
      busFactor,
      risk,
    };
  } catch (_e) {
    return { contributors: 0, topContributors: [], busFactor: 0, risk: 'unknown' };
  }
}

export function assessArchitecture(dir: string): ArchitectureSignals {
  const signals: ArchitectureSignals = {
    languages: [],
    frameworks: [],
    tools: [],
    hasMonorepo: false,
    hasMicroservices: false,
    hasDockerCompose: false,
    hasTerraform: false,
    hasK8s: false,
    testFramework: 'none',
    cicd: 'none',
  };

  const exists = (p: string) => fs.existsSync(path.join(dir, p));

  if (exists('lerna.json') || exists('pnpm-workspace.yaml') || exists('workspaces')) {
    signals.hasMonorepo = true;
  }
  if (exists('docker-compose.yml') || exists('docker-compose.yaml')) {
    signals.hasDockerCompose = true;
    signals.hasMicroservices = true;
    signals.tools.push('Docker');
  }
  if (exists('terraform') || exists('main.tf')) {
    signals.hasTerraform = true;
    signals.tools.push('Terraform');
  }
  if (exists('k8s') || exists('kubernetes')) {
    signals.hasK8s = true;
    signals.tools.push('Kubernetes');
  }

  if (exists('jest.config.js') || exists('jest.config.cjs')) {
    signals.testFramework = 'jest';
    signals.frameworks.push('Jest');
  } else if (exists('vitest.config.ts')) {
    signals.testFramework = 'vitest';
    signals.frameworks.push('Vitest');
  }

  if (exists('.github/workflows')) signals.cicd = 'github-actions';

  return signals;
}

export function calculateDDScore(
  code: CodeQualityStats,
  team: TeamMaturity,
  arch: ArchitectureSignals
): number {
  let score = 50;
  if (code.totalFiles > 10) score += 5;
  if (code.avgFileSize < 300) score += 5;
  if (team.busFactor >= 3) score += 10;
  if (arch.testFramework !== 'none') score += 10;
  if (arch.cicd !== 'none') score += 10;

  return Math.max(0, Math.min(100, score));
}

export function processTechDD(dir: string): DDResult {
  const code = assessCodeQuality(dir);
  const team = assessTeamMaturity(dir);
  const arch = assessArchitecture(dir);
  const score = calculateDDScore(code, team, arch);

  let verdict: DDResult['verdict'] = 'fail';
  if (score >= 80) verdict = 'strong_pass';
  else if (score >= 60) verdict = 'pass';
  else if (score >= 40) verdict = 'conditional_pass';

  const risks: DDRisk[] = [];
  if (team.risk === 'critical') {
    risks.push({
      category: 'Team',
      severity: 'critical',
      risk: `Bus factor is ${team.busFactor} - key person dependency`,
      area: 'Human Resources',
      impact: 'High risk of knowledge loss if key members leave.',
    });
  }
  if (arch.testFramework === 'none') {
    risks.push({
      category: 'Quality',
      severity: 'high',
      risk: 'No test framework detected',
      area: 'Engineering',
      impact: 'Lack of automated verification increases regression risk.',
    });
  }

  return {
    directory: dir,
    score,
    verdict,
    codeQuality: code,
    teamMaturity: team,
    architecture: arch,
    risks,
    recommendations: risks.map((r) => `[${r.severity}] ${r.category}: ${r.risk}`),
  };
}
