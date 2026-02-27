import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getAllFiles } from '@agent/core/fs-utils';
import { StrategicAction } from '@agent/core/shared-business-types';

export interface CodeComplexityStats {
  totalFiles: number;
  totalLines: number;
  avgFileSize: number;
  largeFiles: { file: string; lines: number }[];
  languages: Record<string, number>;
}

export interface TechDebtIndicator {
  file: string;
  todos: number;
  hacks: number;
  fixmes: number;
  deprecated: number;
}

export interface TechDebtResult {
  totalTodos: number;
  totalHacks: number;
  totalFixmes: number;
  debtScore: number;
  hotspots: TechDebtIndicator[];
}

export interface VelocityStats {
  commitsLast4Weeks: number;
  commitsLastWeek: number;
  avgPerWeek: number;
}

export interface InfrastructureChecks {
  hasCICD: boolean;
  hasTests: boolean;
  hasLinting: boolean;
  hasTypeChecking: boolean;
  hasDocumentation: boolean;
  hasContainerization: boolean;
}

export interface RoadmapPhase {
  month: number;
  phase: string;
  items: string[];
}

/**
 * Priority item extending shared StrategicAction.
 */
export interface StrategicPriority extends StrategicAction {
  // action, priority are covered
}

export interface RoadmapResult {
  directory: string;
  planningHorizon: string;
  codeAnalysis: CodeComplexityStats;
  techDebt: TechDebtResult;
  velocity: VelocityStats;
  infrastructure: InfrastructureChecks;
  roadmap: RoadmapPhase[];
  priorities: StrategicPriority[];
}

export function analyzeCodeComplexity(dir: string): CodeComplexityStats {
  const stats: CodeComplexityStats = {
    totalFiles: 0,
    totalLines: 0,
    avgFileSize: 0,
    largeFiles: [],
    languages: {},
  };
  const allFiles = getAllFiles(dir, { maxDepth: 5 });

  const targetExts = [
    '.js',
    '.cjs',
    '.mjs',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.rb',
    '.php',
  ];

  for (const full of allFiles) {
    const ext = path.extname(full).toLowerCase();
    if (!targetExts.includes(ext)) continue;

    try {
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0).length;
      stats.totalFiles++;
      stats.totalLines += lines;
      stats.languages[ext] = (stats.languages[ext] || 0) + 1;
      if (lines > 300) {
        stats.largeFiles.push({ file: path.relative(dir, full), lines });
      }
    } catch (_e) {
      /* ignore */
    }
  }

  stats.avgFileSize = stats.totalFiles > 0 ? Math.round(stats.totalLines / stats.totalFiles) : 0;
  stats.largeFiles.sort((a, b) => b.lines - a.lines);
  stats.largeFiles = stats.largeFiles.slice(0, 10);
  return stats;
}

export function detectTechDebt(dir: string): TechDebtResult {
  const indicators: TechDebtIndicator[] = [];
  const allFiles = getAllFiles(dir, { maxDepth: 5 });

  for (const full of allFiles) {
    if (path.basename(full).match(/\.(js|cjs|mjs|ts|tsx|py|go|rs|java)$/)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        const lower = content.toLowerCase();
        const todos = (lower.match(/\btodo\b/g) || []).length;
        const hacks = (lower.match(/\bhack\b/g) || []).length;
        const fixmes = (lower.match(/\bfixme\b/g) || []).length;
        const deprecated = (lower.match(/\bdeprecated\b/g) || []).length;

        if (todos + hacks + fixmes + deprecated > 0) {
          indicators.push({
            file: path.relative(dir, full),
            todos,
            hacks,
            fixmes,
            deprecated,
          });
        }
      } catch (_e) {
        /* ignore */
      }
    }
  }

  const totalTodos = indicators.reduce((s, i) => s + i.todos, 0);
  const totalHacks = indicators.reduce((s, i) => s + i.hacks, 0);
  const totalFixmes = indicators.reduce((s, i) => s + i.fixmes, 0);

  return {
    totalTodos,
    totalHacks,
    totalFixmes,
    debtScore: Math.min(100, totalTodos * 2 + totalHacks * 5 + totalFixmes * 3),
    hotspots: indicators
      .sort((a, b) => b.todos + b.hacks + b.fixmes - (a.todos + a.hacks + a.fixmes))
      .slice(0, 10),
  };
}

export function getRecentVelocity(dir: string): VelocityStats {
  try {
    const weeks4 = execSync('git log --oneline --since="4 weeks ago" --no-merges', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const weeks1 = execSync('git log --oneline --since="1 week ago" --no-merges', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const total = weeks4.trim().split('\n').filter(Boolean).length;
    const recent = weeks1.trim().split('\n').filter(Boolean).length;
    return { commitsLast4Weeks: total, commitsLastWeek: recent, avgPerWeek: Math.round(total / 4) };
  } catch (_e) {
    return { commitsLast4Weeks: 0, commitsLastWeek: 0, avgPerWeek: 0 };
  }
}

export function checkInfrastructure(dir: string): InfrastructureChecks {
  const exists = (p: string) => fs.existsSync(path.join(dir, p));
  return {
    hasCICD: exists('.github/workflows') || exists('.gitlab-ci.yml') || exists('Jenkinsfile'),
    hasTests: exists('tests') || exists('test') || exists('__tests__') || exists('spec'),
    hasLinting:
      exists('.eslintrc.js') ||
      exists('.eslintrc.json') ||
      exists('eslint.config.mjs') ||
      exists('.pylintrc'),
    hasTypeChecking: exists('tsconfig.json') || exists('mypy.ini') || exists('pyrightconfig.json'),
    hasDocumentation: exists('README.md') || exists('docs'),
    hasContainerization: exists('Dockerfile') || exists('docker-compose.yml'),
  };
}

export function generateRoadmap(
  complexity: CodeComplexityStats,
  debt: TechDebtResult,
  velocity: VelocityStats,
  infra: InfrastructureChecks,
  months: number
): { phases: RoadmapPhase[]; priorities: StrategicPriority[] } {
  const phases: RoadmapPhase[] = [];
  const priorities: StrategicPriority[] = [];

  // Phase 1
  const p1Items: string[] = [];
  if (debt.debtScore > 30) p1Items.push('Address top tech debt hotspots (TODOs, FIXMEs)');
  if (!infra.hasTests) p1Items.push('Establish test suite and coverage baseline');
  if (!infra.hasLinting) p1Items.push('Set up linting and code standards');
  if (!infra.hasCICD) p1Items.push('Configure CI/CD pipeline');
  if (p1Items.length === 0) p1Items.push('Code quality review and optimization');
  phases.push({ month: 1, phase: 'Foundation & Stabilization', items: p1Items });

  // Phase 2
  const p2Items: string[] = [];
  if (!infra.hasTypeChecking) p2Items.push('Add type checking for improved maintainability');
  if (complexity.largeFiles.length > 0)
    p2Items.push(`Refactor ${complexity.largeFiles.length} large files (>300 lines)`);
  if (!infra.hasDocumentation) p2Items.push('Create/improve project documentation');
  p2Items.push('Feature development sprint based on backlog priority');
  phases.push({ month: 2, phase: 'Growth & Feature Development', items: p2Items });

  // Remaining
  for (let m = 3; m <= months; m++) {
    const items = [
      'Performance optimization and monitoring',
      'Security hardening and dependency updates',
    ];
    if (!infra.hasContainerization && m === 3)
      items.push('Containerization and deployment automation');
    items.push('Technical roadmap review and adjustment');
    phases.push({ month: m, phase: `Scaling & Optimization (Month ${m})`, items });
  }

  // Dynamic Priority Logic
  if (debt.debtScore > 50 || (velocity.avgPerWeek < 3 && debt.debtScore > 20)) {
    priorities.push({
      priority: 'critical',
      action: `Tech debt inhibiting velocity (Score: ${debt.debtScore}) - allocate 40% capacity to debt reduction`,
      area: 'Engineering Excellence',
    });
  } else if (debt.debtScore > 30) {
    priorities.push({
      priority: 'high',
      action: `Significant tech debt (Score: ${debt.debtScore}) - allocate 20% capacity to maintenance`,
      area: 'Engineering Excellence',
    });
  }

  if (velocity.avgPerWeek < 5 && velocity.avgPerWeek > 0) {
    priorities.push({
      priority: 'high',
      action: 'Low velocity detected - review CI/CD bottlenecks and process efficiency',
      area: 'Process Optimization',
    });
  } else if (velocity.avgPerWeek === 0) {
    priorities.push({
      priority: 'critical',
      action: 'Stalled velocity - immediate investigation of project blockers required',
      area: 'Process Optimization',
    });
  }

  if (complexity.avgFileSize > 200) {
    priorities.push({
      priority: 'medium',
      action: `Average file size ${complexity.avgFileSize} lines - consider modularization`,
      area: 'Architecture',
    });
  }

  return { phases, priorities };
}
