import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core';

export type UiUxGovernanceViolation = {
  rule: 'hardcoded-color' | 'missing-semantic-token' | 'status-vocabulary-bypass';
  path: string;
  detail: string;
};

export type UiUxGovernanceReport = {
  status: 'pass' | 'fail';
  owner: 'design-system-steward';
  checked_at: string;
  checked_files: number;
  violations: UiUxGovernanceViolation[];
  next_actions: string[];
};

const OPERATOR_SOURCE = 'presence/displays/operator-surface/src';
const GENERATED_TOKEN_FILES = [
  'presence/displays/chronos-mirror-v2/src/app/globals.css',
  'presence/displays/operator-surface/src/app/globals.css',
  'presence/displays/presence-studio/static/design-tokens.css',
  'presence/displays/computer-surface/static/design-tokens.css',
];
const REQUIRED_SEMANTIC_TOKENS = [
  '--kb-accent-text',
  '--kb-surface',
  '--kb-muted-text',
  '--kb-border',
  '--kb-success',
  '--kb-danger',
];
const RAW_COLOR_PATTERN = /(?:#[0-9a-f]{3,8}\b|\brgba?\s*\()/giu;

function walkFiles(directory: string): string[] {
  if (!safeExistsSync(directory)) return [];
  return safeReaddir(directory).flatMap((entry) => {
    const filePath = path.join(directory, entry);
    return safeStat(filePath).isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

export function findHardcodedColorViolations(
  source: string,
  relativePath: string
): UiUxGovernanceViolation[] {
  return source.split('\n').flatMap((line, index) => {
    RAW_COLOR_PATTERN.lastIndex = 0;
    return RAW_COLOR_PATTERN.test(line)
      ? [
          {
            rule: 'hardcoded-color' as const,
            path: relativePath,
            detail: `line ${index + 1}: use a canonical --kb-* semantic token`,
          },
        ]
      : [];
  });
}

export function collectUiUxGovernanceReport(now = new Date()): UiUxGovernanceReport {
  const violations: UiUxGovernanceViolation[] = [];
  const operatorRoot = pathResolver.rootResolve(OPERATOR_SOURCE);
  const operatorFiles = walkFiles(operatorRoot).filter((file) => /\.(?:ts|tsx)$/u.test(file));

  for (const filePath of operatorFiles) {
    const relativePath = path.relative(pathResolver.rootDir(), filePath);
    const source = String(safeReadFile(filePath, { encoding: 'utf8' }));
    violations.push(...findHardcodedColorViolations(source, relativePath));
  }

  for (const relativePath of GENERATED_TOKEN_FILES) {
    const filePath = pathResolver.rootResolve(relativePath);
    const source = safeExistsSync(filePath)
      ? String(safeReadFile(filePath, { encoding: 'utf8' }))
      : '';
    for (const token of REQUIRED_SEMANTIC_TOKENS) {
      if (!source.includes(`${token}:`)) {
        violations.push({
          rule: 'missing-semantic-token',
          path: relativePath,
          detail: `${token} is missing; run the canonical token generator`,
        });
      }
    }
  }

  const dashboardPath = 'scripts/sovereign_dashboard.ts';
  const dashboardSource = String(
    safeReadFile(pathResolver.rootResolve(dashboardPath), { encoding: 'utf8' })
  );
  const rendererUses = dashboardSource.match(/renderStatus\s*\(/gu)?.length ?? 0;
  if (rendererUses < 5) {
    violations.push({
      rule: 'status-vocabulary-bypass',
      path: dashboardPath,
      detail: `expected shared renderStatus coverage across dashboard domains; found ${rendererUses} calls`,
    });
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    owner: 'design-system-steward',
    checked_at: now.toISOString(),
    checked_files: operatorFiles.length + GENERATED_TOKEN_FILES.length + 1,
    violations,
    next_actions:
      violations.length === 0
        ? ['Keep pipelines/ui-ux-governance-audit.json enabled for weekly drift detection.']
        : [
            'Run the canonical design-token generator for token drift.',
            'Replace operator-surface raw colors with semantic --kb-* tokens.',
            'Route dashboard statuses through renderStatus().',
          ],
  };
}

function main(): void {
  const report = collectUiUxGovernanceReport();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.status === 'pass') {
    console.log(`[check:ui-ux] OK (${report.checked_files} files, owner=${report.owner})`);
  } else {
    console.error(`[check:ui-ux] ${report.violations.length} violation(s) detected:`);
    for (const violation of report.violations) {
      console.error(`- ${violation.rule}: ${violation.path} — ${violation.detail}`);
    }
  }
  if (report.status === 'fail') process.exitCode = 1;
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMainModule) main();
