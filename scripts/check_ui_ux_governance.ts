import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
const REQUIRED_SEMANTIC_TOKENS = [
  '--kb-accent-text',
  '--kb-surface',
  '--kb-muted-text',
  '--kb-border',
  '--kb-success',
  '--kb-danger',
];
// UI-02 web UI layer (tokens.ui → --kb-ui-*).
const REQUIRED_UI_TOKENS = [
  '--kb-ui-canvas',
  '--kb-ui-surface',
  '--kb-ui-text',
  '--kb-ui-text-muted',
  '--kb-ui-accent',
  '--kb-ui-focus-ring',
  '--kb-ui-danger-fg',
  '--kb-ui-font-size-md',
];
// kyberion-ui.css defines the component class contract; a stylesheet missing
// one of these roots has drifted from the kyberion-base catalog.
const REQUIRED_UI_COMPONENT_CLASSES = [
  '.kb-app-shell',
  '.kb-page-header',
  '.kb-nav-rail',
  '.kb-tabs',
  '.kb-stack',
  '.kb-grid',
  '.kb-section',
  '.kb-next-action',
  '.kb-metric',
  '.kb-kv',
  '.kb-table',
  '.kb-list',
  '.kb-text--',
  '.kb-status-pill',
  '.kb-badge',
  '.kb-callout',
  '.kb-empty-state',
  '.kb-skeleton',
  '.kb-btn--primary',
  '.kb-disclosure',
];
const UI_COMPONENT_STYLESHEET_REQUIREMENTS = [
  ...REQUIRED_UI_COMPONENT_CLASSES,
  'prefers-reduced-motion',
  ':focus-visible',
];
/** Generated design-token outputs and the markers each must contain. */
const GENERATED_TOKEN_FILES: Record<string, readonly string[]> = {
  'presence/displays/chronos-mirror-v2/src/app/globals.css': [
    ...REQUIRED_SEMANTIC_TOKENS,
    ...REQUIRED_UI_TOKENS,
  ],
  'presence/displays/operator-surface/src/app/globals.css': [
    ...REQUIRED_SEMANTIC_TOKENS,
    ...REQUIRED_UI_TOKENS,
  ],
  'presence/displays/presence-studio/static/design-tokens.css': [
    ...REQUIRED_SEMANTIC_TOKENS,
    ...REQUIRED_UI_TOKENS,
  ],
  'presence/displays/computer-surface/static/design-tokens.css': [
    ...REQUIRED_SEMANTIC_TOKENS,
    ...REQUIRED_UI_TOKENS,
  ],
  'presence/displays/concierge/src/app/kyberion-ui-tokens.css': REQUIRED_UI_TOKENS,
  'presence/displays/chronos-mirror-v2/src/app/kyberion-ui.css':
    UI_COMPONENT_STYLESHEET_REQUIREMENTS,
  'presence/displays/operator-surface/src/app/kyberion-ui.css':
    UI_COMPONENT_STYLESHEET_REQUIREMENTS,
  'presence/displays/presence-studio/static/kyberion-ui.css': UI_COMPONENT_STYLESHEET_REQUIREMENTS,
  'presence/displays/computer-surface/static/kyberion-ui.css': UI_COMPONENT_STYLESHEET_REQUIREMENTS,
  'presence/displays/concierge/src/app/kyberion-ui.css': UI_COMPONENT_STYLESHEET_REQUIREMENTS,
};
const RAW_COLOR_PATTERN = /(?:#[0-9a-f]{3,8}\b|\brgba?\s*\()/giu;

export function readUiUxGovernanceTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

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
    const source = readUiUxGovernanceTextFile(filePath);
    violations.push(...findHardcodedColorViolations(source, relativePath));
  }

  for (const [relativePath, required] of Object.entries(GENERATED_TOKEN_FILES)) {
    const filePath = pathResolver.rootResolve(relativePath);
    const source = safeExistsSync(filePath) ? readUiUxGovernanceTextFile(filePath) : '';
    for (const marker of required) {
      // Custom properties must be declared (`--x:`); class/at-rule markers must appear.
      const needle = marker.startsWith('--') ? `${marker}:` : marker;
      if (!source.includes(needle)) {
        violations.push({
          rule: 'missing-semantic-token',
          path: relativePath,
          detail: `${marker} is missing; run the canonical token generator`,
        });
      }
    }
  }

  const dashboardPath = 'scripts/sovereign_dashboard.ts';
  const dashboardSource = readUiUxGovernanceTextFile(pathResolver.rootResolve(dashboardPath));
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
    checked_files: operatorFiles.length + Object.keys(GENERATED_TOKEN_FILES).length + 1,
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

export const runCheckUiUxGovernance = defineScript({
  name: 'check:ui-ux',
  flags: ['json'],
  run(context) {
    const report = collectUiUxGovernanceReport();
    if (context.json) {
      context.print(report);
    } else if (report.status === 'pass') {
      context.print(`[check:ui-ux] OK (${report.checked_files} files, owner=${report.owner})`);
    } else {
      throw new ScriptExitError(
        1,
        [
          `${report.violations.length} violation(s) detected:`,
          ...report.violations.map(
            (violation) => `- ${violation.rule}: ${violation.path} — ${violation.detail}`
          ),
        ].join('\n')
      );
    }
    if (report.status === 'fail') throw new ScriptExitError(1);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_ui_ux_governance.ts') ||
  isDirectScript(import.meta.url, 'check_ui_ux_governance.js')
)
  void runCheckUiUxGovernance();
