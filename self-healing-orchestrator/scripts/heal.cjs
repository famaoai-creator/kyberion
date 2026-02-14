#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * self-healing-orchestrator: Pattern-based automatic repair for known issues.
 * Matches error patterns against healing runbooks and proposes/applies fixes.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to error log or JSON error report',
  })
  .option('dry-run', {
    type: 'boolean',
    default: true,
    description: 'Only propose fixes without applying them',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

// --- Healing Runbook: pattern -> repair action ---
const HEALING_RUNBOOK = [
  {
    id: 'npm-missing-module',
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    severity: 'medium',
    diagnosis: 'Missing Node.js dependency',
    action: 'npm install',
    category: 'dependency',
  },
  {
    id: 'econnrefused',
    pattern: /ECONNREFUSED|Connection refused/i,
    severity: 'high',
    diagnosis: 'Service connection refused - target service may be down',
    action: 'Check if the target service is running. Restart if needed.',
    category: 'connectivity',
  },
  {
    id: 'enospc',
    pattern: /ENOSPC|No space left/i,
    severity: 'critical',
    diagnosis: 'Disk space exhausted',
    action: 'Free disk space: remove old logs, clean docker images, clear tmp',
    category: 'infrastructure',
  },
  {
    id: 'oom',
    pattern: /out of memory|heap|ENOMEM/i,
    severity: 'critical',
    diagnosis: 'Out of memory error',
    action: 'Increase memory allocation or optimize memory usage. Check for memory leaks.',
    category: 'infrastructure',
  },
  {
    id: 'timeout',
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    severity: 'medium',
    diagnosis: 'Operation timed out',
    action:
      'Check network connectivity, increase timeout values, or investigate slow dependencies.',
    category: 'connectivity',
  },
  {
    id: 'permission',
    pattern: /EACCES|Permission denied|EPERM/i,
    severity: 'medium',
    diagnosis: 'Permission denied',
    action:
      'Check file/directory permissions. Ensure the process runs with appropriate user privileges.',
    category: 'permissions',
  },
  {
    id: 'port-in-use',
    pattern: /EADDRINUSE|address already in use/i,
    severity: 'medium',
    diagnosis: 'Port already in use',
    action: 'Kill the process using the port or use a different port.',
    category: 'infrastructure',
  },
  {
    id: 'db-connection',
    pattern: /database.*connect|ECONNRESET.*db|connection.*pool/i,
    severity: 'high',
    diagnosis: 'Database connection failure',
    action: 'Check database credentials, network access, and connection pool configuration.',
    category: 'database',
  },
  {
    id: 'syntax-error',
    pattern: /SyntaxError|Unexpected token/i,
    severity: 'high',
    diagnosis: 'Code or configuration syntax error',
    action: 'Check recently changed files for syntax issues. Run linter.',
    category: 'code',
  },
  {
    id: 'cert-error',
    pattern: /CERT_|certificate|ssl|TLS/i,
    severity: 'high',
    diagnosis: 'SSL/TLS certificate issue',
    action: 'Check certificate expiry, chain, and trust store configuration.',
    category: 'security',
  },
];

function parseInput(inputPath) {
  const content = fs.readFileSync(inputPath, 'utf8');

  // Try JSON first (e.g., from crisis-manager output)
  try {
    const json = JSON.parse(content);
    const errors = [];
    if (json.logAnalysis && json.logAnalysis.recentErrors) {
      errors.push(...json.logAnalysis.recentErrors);
    }
    if (json.error && json.error.message) {
      errors.push(json.error.message);
    }
    if (json.incident && json.incident.immediateActions) {
      errors.push(...json.incident.immediateActions);
    }
    if (errors.length > 0) return errors;
  } catch (_e) {
    /* not JSON, treat as plain text log */
  }

  // Plain text: extract lines with errors
  return content
    .split('\n')
    .filter((line) => /error|exception|fatal|critical|fail/i.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-100);
}

function matchRunbook(errors) {
  const matches = [];
  const matched = new Set();

  for (const error of errors) {
    for (const rule of HEALING_RUNBOOK) {
      if (rule.pattern.test(error) && !matched.has(rule.id)) {
        matched.add(rule.id);
        matches.push({
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          diagnosis: rule.diagnosis,
          proposedAction: rule.action,
          triggerLine: error.substring(0, 200),
        });
      }
    }
  }

  return matches.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
  });
}

runSkill('self-healing-orchestrator', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const errors = parseInput(resolved);
  const healingPlan = matchRunbook(errors);

  const result = {
    source: path.basename(resolved),
    mode: argv['dry-run'] ? 'dry-run' : 'apply',
    errorsAnalyzed: errors.length,
    matchedRules: healingPlan.length,
    healingPlan,
    unmatchedErrors: errors.length - healingPlan.reduce((s, _h) => s + 1, 0),
    summary:
      healingPlan.length > 0
        ? `Found ${healingPlan.length} actionable patterns. Top issue: ${healingPlan[0].diagnosis}`
        : 'No known error patterns matched. Manual investigation recommended.',
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
