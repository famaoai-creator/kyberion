#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * pmo-governance-lead: Performs PMO governance audits on project directories.
 * Checks quality gates, required evidence, and phase readiness.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory to audit',
  })
  .option('phase', {
    alias: 'p',
    type: 'string',
    choices: ['requirements', 'design', 'implementation', 'testing', 'deployment', 'all'],
    default: 'all',
    description: 'SDLC phase to check',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

const QUALITY_GATES = {
  requirements: {
    name: 'Requirements Phase',
    evidence: [
      { type: 'file', patterns: ['**/requirements*.md', '**/PRD*.md', '**/specs/**', '**/requirements*.yaml'], label: 'Requirements Document' },
      { type: 'file', patterns: ['**/stakeholder*', '**/meeting-notes*'], label: 'Stakeholder Sign-off' },
    ],
    weight: 20,
  },
  design: {
    name: 'Design Phase',
    evidence: [
      { type: 'file', patterns: ['**/design*.md', '**/architecture*.md', '**/diagrams/**', '**/ADR*'], label: 'Design Document / ADR' },
      { type: 'file', patterns: ['**/schema*', '**/erd*', '**/openapi*', '**/swagger*'], label: 'Schema / API Design' },
    ],
    weight: 20,
  },
  implementation: {
    name: 'Implementation Phase',
    evidence: [
      { type: 'dir', patterns: ['src/', 'lib/', 'app/', 'scripts/'], label: 'Source Code' },
      { type: 'file', patterns: ['.gitignore', '.editorconfig'], label: 'Development Standards' },
      { type: 'file', patterns: ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'], label: 'Contributing Guidelines' },
    ],
    weight: 20,
  },
  testing: {
    name: 'Testing Phase',
    evidence: [
      { type: 'dir', patterns: ['tests/', 'test/', '__tests__/', 'spec/', 'e2e/'], label: 'Test Suite' },
      { type: 'file', patterns: ['jest.config*', 'vitest.config*', 'pytest.ini', '.rspec', 'cypress.config*'], label: 'Test Configuration' },
      { type: 'file', patterns: ['**/coverage/**', '.c8rc*', '.nycrc*', 'codecov*'], label: 'Coverage Configuration' },
    ],
    weight: 20,
  },
  deployment: {
    name: 'Deployment Phase',
    evidence: [
      { type: 'file', patterns: ['.github/workflows/*', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'], label: 'CI/CD Pipeline' },
      { type: 'file', patterns: ['Dockerfile', 'docker-compose*', 'k8s/**', 'terraform/**'], label: 'Infrastructure Config' },
      { type: 'file', patterns: ['CHANGELOG.md', 'RELEASE*'], label: 'Release Documentation' },
    ],
    weight: 20,
  },
};

function simpleGlob(dir, pattern) {
  // Simple pattern matching for common glob patterns
  const parts = pattern.split('/');
  const fileName = parts[parts.length - 1];
  const hasWildDir = parts.some(p => p === '**');

  try {
    if (hasWildDir) {
      return searchRecursive(dir, fileName, 3);
    }
    const targetDir = parts.length > 1 ? path.join(dir, ...parts.slice(0, -1)) : dir;
    if (!fs.existsSync(targetDir)) return [];
    const files = fs.readdirSync(targetDir);
    const regex = new RegExp('^' + fileName.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return files.filter(f => regex.test(f)).map(f => path.join(targetDir, f));
  } catch (_e) {
    return [];
  }
}

function searchRecursive(dir, filePattern, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  const regex = new RegExp('^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isFile() && regex.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        results.push(...searchRecursive(path.join(dir, entry.name), filePattern, maxDepth, depth + 1));
      }
    }
  } catch (_e) { /* skip */ }
  return results;
}

function checkEvidence(dir, evidence) {
  for (const pattern of evidence.patterns) {
    if (evidence.type === 'dir') {
      const dirPath = path.join(dir, pattern.replace('/', ''));
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        return { found: true, match: pattern };
      }
    } else {
      const matches = simpleGlob(dir, pattern);
      if (matches.length > 0) {
        return { found: true, match: path.relative(dir, matches[0]) };
      }
    }
  }
  return { found: false };
}

function auditPhase(dir, phaseKey) {
  const gate = QUALITY_GATES[phaseKey];
  const results = [];
  let passed = 0;

  for (const evidence of gate.evidence) {
    const check = checkEvidence(dir, evidence);
    results.push({
      label: evidence.label,
      status: check.found ? 'found' : 'missing',
      match: check.match || null,
    });
    if (check.found) passed++;
  }

  const completion = gate.evidence.length > 0 ? Math.round((passed / gate.evidence.length) * 100) : 0;

  return {
    phase: gate.name,
    completion,
    status: completion >= 100 ? 'ready' : completion >= 50 ? 'partial' : 'not_ready',
    evidence: results,
  };
}

function identifyRisks(phaseResults) {
  const risks = [];

  for (const phase of phaseResults) {
    if (phase.status === 'not_ready') {
      risks.push({
        severity: 'high',
        phase: phase.phase,
        risk: `${phase.phase} has insufficient evidence (${phase.completion}% complete)`,
      });
    }
    const missing = phase.evidence.filter(e => e.status === 'missing');
    for (const m of missing) {
      risks.push({
        severity: phase.completion < 50 ? 'high' : 'medium',
        phase: phase.phase,
        risk: `Missing: ${m.label}`,
      });
    }
  }

  return risks;
}

runSkill('pmo-governance-lead', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const phases = argv.phase === 'all' ? Object.keys(QUALITY_GATES) : [argv.phase];
  const phaseResults = phases.map(p => auditPhase(targetDir, p));
  const risks = identifyRisks(phaseResults);

  const totalCompletion = phaseResults.length > 0
    ? Math.round(phaseResults.reduce((s, p) => s + p.completion, 0) / phaseResults.length)
    : 0;

  let overallStatus = 'not_ready';
  if (totalCompletion >= 80) overallStatus = 'ready';
  else if (totalCompletion >= 50) overallStatus = 'partial';

  const result = {
    directory: targetDir,
    overallCompletion: totalCompletion,
    overallStatus,
    phases: phaseResults,
    risks,
    highRiskCount: risks.filter(r => r.severity === 'high').length,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
