#!/usr/bin/env node
/**
 * compliance-officer: Maps project state to regulatory standards (SOC2, ISO27001, HIPAA).
 * Generates compliance scores and audit-ready evidence.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('standard', { alias: 's', type: 'string', default: 'soc2', choices: ['soc2', 'iso27001', 'hipaa', 'gdpr', 'all'], description: 'Compliance standard' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const CONTROLS = {
  soc2: {
    name: 'SOC 2 Type II',
    categories: [
      { id: 'CC6', name: 'Logical & Physical Access', checks: [
        { id: 'CC6.1', label: 'Authentication controls', patterns: ['.env.example', 'auth', 'login', 'session'] },
        { id: 'CC6.2', label: 'Access logging', patterns: ['audit-log', 'access.log', 'logger'] },
        { id: 'CC6.3', label: 'Encryption at rest', patterns: ['encrypt', 'aes', 'kms', 'vault'] },
      ]},
      { id: 'CC7', name: 'System Operations', checks: [
        { id: 'CC7.1', label: 'Monitoring & alerting', patterns: ['monitor', 'alert', 'prometheus', 'grafana', 'datadog'] },
        { id: 'CC7.2', label: 'Incident response', patterns: ['incident', 'runbook', 'escalat', 'on-call'] },
        { id: 'CC7.3', label: 'Backup & recovery', patterns: ['backup', 'restore', 'disaster-recovery', 'dr'] },
      ]},
      { id: 'CC8', name: 'Change Management', checks: [
        { id: 'CC8.1', label: 'Version control', patterns: ['.git', '.gitignore'] },
        { id: 'CC8.2', label: 'CI/CD pipeline', patterns: ['.github/workflows', '.gitlab-ci', 'Jenkinsfile'] },
        { id: 'CC8.3', label: 'Code review process', patterns: ['CODEOWNERS', 'pull_request_template', 'CONTRIBUTING'] },
      ]},
    ],
  },
  iso27001: {
    name: 'ISO 27001',
    categories: [
      { id: 'A5', name: 'Information Security Policies', checks: [
        { id: 'A5.1', label: 'Security policy document', patterns: ['SECURITY.md', 'security-policy'] },
      ]},
      { id: 'A8', name: 'Asset Management', checks: [
        { id: 'A8.1', label: 'Asset inventory', patterns: ['package.json', 'requirements.txt', 'go.mod'] },
        { id: 'A8.2', label: 'Dependency management', patterns: ['package-lock.json', 'yarn.lock', 'Pipfile.lock'] },
      ]},
      { id: 'A12', name: 'Operations Security', checks: [
        { id: 'A12.1', label: 'Logging', patterns: ['logger', 'winston', 'pino', 'log4j'] },
        { id: 'A12.4', label: 'Vulnerability management', patterns: ['snyk', 'dependabot', 'npm audit', 'security-scanner'] },
      ]},
    ],
  },
  hipaa: {
    name: 'HIPAA',
    categories: [
      { id: 'PHI', name: 'PHI Protection', checks: [
        { id: 'PHI.1', label: 'Data encryption', patterns: ['encrypt', 'tls', 'ssl', 'https'] },
        { id: 'PHI.2', label: 'Access controls', patterns: ['rbac', 'role', 'permission', 'auth'] },
        { id: 'PHI.3', label: 'Audit trail', patterns: ['audit', 'log', 'trail', 'track'] },
      ]},
      { id: 'ADMIN', name: 'Administrative Safeguards', checks: [
        { id: 'ADMIN.1', label: 'Risk assessment', patterns: ['risk', 'assessment', 'security-scan'] },
        { id: 'ADMIN.2', label: 'Contingency plan', patterns: ['backup', 'disaster', 'contingency', 'recovery'] },
      ]},
    ],
  },
  gdpr: {
    name: 'GDPR',
    categories: [
      { id: 'ART25', name: 'Data Protection by Design', checks: [
        { id: 'ART25.1', label: 'Privacy by design', patterns: ['privacy', 'consent', 'gdpr', 'data-protection'] },
        { id: 'ART25.2', label: 'Data minimization', patterns: ['minimal', 'necessary', 'purpose-limit'] },
      ]},
      { id: 'ART32', name: 'Security of Processing', checks: [
        { id: 'ART32.1', label: 'Encryption', patterns: ['encrypt', 'hash', 'bcrypt', 'argon'] },
        { id: 'ART32.2', label: 'Pseudonymization', patterns: ['anonymiz', 'pseudonym', 'mask', 'redact'] },
      ]},
    ],
  },
};

function searchEvidence(dir, patterns, maxDepth) {
  for (const pattern of patterns) {
    // Check as file/dir path
    const full = path.join(dir, pattern);
    if (fs.existsSync(full)) return { found: true, evidence: pattern, type: 'file' };
  }
  // Search in code content
  function search(d, depth) {
    if (depth > maxDepth) return null;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { const r = search(full, depth+1); if (r) return r; continue; }
        if (!['.js','.cjs','.ts','.py','.go','.java','.md','.yml','.yaml'].includes(path.extname(e.name))) continue;
        try {
          const content = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const p of patterns) { if (content.includes(p)) return { found: true, evidence: path.relative(dir, full), type: 'content', keyword: p }; }
        } catch(_e){}
      }
    } catch(_e){}
    return null;
  }
  return search(dir, 0) || { found: false };
}

function auditStandard(dir, standardKey) {
  const standard = CONTROLS[standardKey];
  const results = [];
  let totalChecks = 0, passed = 0;

  for (const cat of standard.categories) {
    const catResults = [];
    for (const check of cat.checks) {
      totalChecks++;
      const evidence = searchEvidence(dir, check.patterns, 3);
      if (evidence.found) passed++;
      catResults.push({ id: check.id, label: check.label, status: evidence.found ? 'compliant' : 'gap', evidence: evidence.found ? evidence.evidence : null });
    }
    results.push({ id: cat.id, name: cat.name, checks: catResults, compliance: Math.round(catResults.filter(c => c.status === 'compliant').length / catResults.length * 100) });
  }

  return { standard: standard.name, totalChecks, passed, complianceScore: Math.round((passed/totalChecks)*100), categories: results };
}

runSkill('compliance-officer', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const standards = argv.standard === 'all' ? Object.keys(CONTROLS) : [argv.standard];
  const audits = standards.map(s => auditStandard(targetDir, s));

  const overallScore = Math.round(audits.reduce((s,a) => s + a.complianceScore, 0) / audits.length);
  const gaps = audits.flatMap(a => a.categories.flatMap(c => c.checks.filter(ch => ch.status === 'gap').map(ch => ({ standard: a.standard, control: ch.id, label: ch.label }))));

  const result = {
    directory: targetDir, standardsAudited: standards, overallComplianceScore: overallScore,
    status: overallScore >= 80 ? 'compliant' : overallScore >= 50 ? 'partial' : 'non_compliant',
    audits, gaps: gaps.slice(0, 20), gapCount: gaps.length,
    recommendations: gaps.slice(0, 5).map(g => `[${g.standard}] ${g.control}: Implement ${g.label}`),
  };

  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
