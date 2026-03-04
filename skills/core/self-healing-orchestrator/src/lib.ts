import * as fs from 'node:fs';

/**
 * Self-Healing Orchestrator Core Library.
 * Matches error patterns with healing runbooks.
 */

export interface HealingAction {
  ruleId: string;
  diagnosis: string;
  proposedAction: string;
  severity: 'high' | 'medium' | 'low';
}

const HEALING_RUNBOOK = [
  {
    id: 'npm-missing-module',
    regex: /Cannot find module ['"](.+)['"]/i,
    diagnosis: 'Missing NPM dependency: $1',
    action: 'Run: pnpm install',
    severity: 'medium'
  },
  {
    id: 'econnrefused',
    regex: /ECONNREFUSED/i,
    diagnosis: 'Service connection refused.',
    action: 'Restart target service and verify network policy.',
    severity: 'high'
  },
  {
    id: 'permission',
    regex: /EACCES|Permission denied/i,
    diagnosis: 'File system permission error.',
    action: 'Check directory ownership and chmod settings.',
    severity: 'high'
  },
  {
    id: 'syntax-error',
    regex: /SyntaxError/i,
    diagnosis: 'Source code syntax error.',
    action: 'Run: npm run typecheck to find the error.',
    severity: 'medium'
  },
  {
    id: 'disk-full',
    regex: /ENOSPC|no space left/i,
    diagnosis: 'Disk space exhausted.',
    action: 'Run: npm run clean and purge old evidence logs.',
    severity: 'high'
  }
];

export function parseInput(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    const parsed = JSON.parse(content);
    // Extract errors from JSON report
    const errors: string[] = [];
    if (parsed.error?.message) errors.push(parsed.error.message);
    if (parsed.logAnalysis?.recentErrors) errors.push(...parsed.logAnalysis.recentErrors);
    return errors;
  } catch (_) {
    // Fallback to plain text lines
    return content.split('\n').filter(l => l.includes('ERROR') || l.includes('FATAL'));
  }
}

export function matchRunbook(errors: string[]): HealingAction[] {
  const actions: HealingAction[] = [];

  errors.forEach((error) => {
    HEALING_RUNBOOK.forEach((rule) => {
      const match = error.match(rule.regex);
      if (match) {
        actions.push({
          ruleId: rule.id,
          diagnosis: rule.diagnosis.replace('$1', match[1] || ''),
          proposedAction: rule.action,
          severity: rule.severity as any
        });
      }
    });
  });

  // Sort by severity (high first)
  const weight = { high: 3, medium: 2, low: 1 };
  return actions.sort((a, b) => weight[b.severity] - weight[a.severity]);
}

export function autoHealTestFailure(filePath: string): HealingAction[] {
  const errors = parseInput(filePath);
  return matchRunbook(errors);
}
