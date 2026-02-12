#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * investor-readiness-audit: Audits project readiness for fundraising, board meetings, or IPO.
 * Validates documentation, financial data, technical health, and compliance.
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
  .option('stage', {
    alias: 's',
    type: 'string',
    default: 'series-a',
    choices: ['seed', 'series-a', 'series-b', 'ipo'],
    description: 'Fundraising stage',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

const DATA_ROOM_CHECKLIST = {
  seed: {
    required: [
      { category: 'Product', items: ['README.md or product overview', 'Working demo or prototype'] },
      { category: 'Team', items: ['Team bios or CONTRIBUTORS file'] },
      { category: 'Technical', items: ['Source code repository', 'Basic CI/CD'] },
    ],
  },
  'series-a': {
    required: [
      { category: 'Product', items: ['README.md or product overview', 'Architecture documentation', 'API documentation'] },
      { category: 'Technical', items: ['Source code repository', 'CI/CD pipeline', 'Test suite', 'Security audit results'] },
      { category: 'Financial', items: ['Revenue metrics', 'Cost breakdown', 'Growth projections'] },
      { category: 'Legal', items: ['LICENSE file', 'Third-party dependency audit', 'Privacy policy'] },
    ],
  },
  'series-b': {
    required: [
      { category: 'Product', items: ['README.md or product overview', 'Architecture documentation', 'API documentation', 'Scaling plan'] },
      { category: 'Technical', items: ['Source code repository', 'CI/CD pipeline', 'Test suite (>70% coverage)', 'Security audit results', 'Performance benchmarks', 'Disaster recovery plan'] },
      { category: 'Financial', items: ['Revenue metrics', 'Unit economics', 'Cost breakdown', 'Growth projections', 'Burn rate analysis'] },
      { category: 'Legal', items: ['LICENSE file', 'SBoM', 'Compliance certifications', 'Privacy policy', 'IP documentation'] },
      { category: 'Team', items: ['Org chart', 'Key person dependencies', 'Hiring plan'] },
    ],
  },
  ipo: {
    required: [
      { category: 'Product', items: ['README.md', 'Architecture documentation', 'API documentation', 'Scaling plan', 'Competitive analysis'] },
      { category: 'Technical', items: ['Source code', 'CI/CD', 'Test suite (>80%)', 'Security audit', 'Performance benchmarks', 'DR plan', 'SOC2/ISO27001'] },
      { category: 'Financial', items: ['Audited financials', 'Revenue metrics', 'Unit economics', 'Projections', 'Burn rate', 'Cap table'] },
      { category: 'Legal', items: ['LICENSE', 'SBoM', 'All compliance certs', 'Privacy policy', 'IP portfolio', 'Material contracts'] },
      { category: 'Team', items: ['Org chart', 'Key person insurance', 'Board composition', 'Advisory board'] },
    ],
  },
};

function checkItem(dir, item) {
  const lower = item.toLowerCase();
  const checks = [];

  if (lower.includes('readme')) checks.push('README.md', 'README', 'readme.md');
  if (lower.includes('license')) checks.push('LICENSE', 'LICENSE.md', 'LICENCE');
  if (lower.includes('architecture')) checks.push('docs/architecture.md', 'ARCHITECTURE.md', 'design/architecture.md');
  if (lower.includes('api doc')) checks.push('docs/api.md', 'openapi.yaml', 'swagger.json', 'API.md');
  if (lower.includes('ci/cd') || lower.includes('pipeline')) checks.push('.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile');
  if (lower.includes('test suite')) checks.push('tests', 'test', '__tests__', 'spec');
  if (lower.includes('source code')) checks.push('src', 'lib', 'scripts', 'app');
  if (lower.includes('security audit')) checks.push('SECURITY.md', 'security-audit.json', 'docs/security.md');
  if (lower.includes('privacy')) checks.push('PRIVACY.md', 'privacy-policy.md');
  if (lower.includes('sbom')) checks.push('sbom.json', 'sbom.xml', 'bom.json');
  if (lower.includes('dr plan') || lower.includes('disaster recovery')) checks.push('docs/disaster-recovery.md', 'DR.md');
  if (lower.includes('contributor')) checks.push('CONTRIBUTORS', 'CONTRIBUTORS.md');
  if (lower.includes('changelog')) checks.push('CHANGELOG.md', 'CHANGES.md');
  if (lower.includes('performance')) checks.push('docs/performance.md', 'benchmarks');
  if (lower.includes('compliance') || lower.includes('soc2') || lower.includes('iso27001')) checks.push('docs/compliance.md', 'compliance');

  for (const check of checks) {
    const full = path.join(dir, check);
    if (fs.existsSync(full)) return { found: true, match: check };
  }

  // Fallback: try to find any matching file
  if (checks.length === 0) {
    const keyword = lower.split(' ')[0];
    try {
      const entries = fs.readdirSync(dir);
      const match = entries.find(e => e.toLowerCase().includes(keyword));
      if (match) return { found: true, match };
    } catch (_e) { /* skip */ }
  }

  return { found: false };
}

function auditDataRoom(dir, stage) {
  const checklist = DATA_ROOM_CHECKLIST[stage];
  const results = [];
  let totalItems = 0, foundItems = 0;

  for (const category of checklist.required) {
    const categoryResults = [];
    for (const item of category.items) {
      totalItems++;
      const check = checkItem(dir, item);
      if (check.found) foundItems++;
      categoryResults.push({ item, status: check.found ? 'found' : 'missing', match: check.match || null });
    }
    results.push({ category: category.category, items: categoryResults, completion: Math.round(categoryResults.filter(r => r.status === 'found').length / categoryResults.length * 100) });
  }

  return { results, totalItems, foundItems, completionPercent: Math.round((foundItems / totalItems) * 100) };
}

function assessRisks(audit, stage) {
  const risks = [];
  for (const cat of audit.results) {
    const missing = cat.items.filter(i => i.status === 'missing');
    if (missing.length > 0) {
      const severity = cat.category === 'Legal' || cat.category === 'Financial' ? 'high' : 'medium';
      risks.push({ category: cat.category, severity, missing: missing.map(m => m.item), impact: `${missing.length} missing item(s) in ${cat.category}` });
    }
  }
  if (audit.completionPercent < 50) risks.push({ category: 'Overall', severity: 'critical', missing: [], impact: `Only ${audit.completionPercent}% ready for ${stage} - significant preparation needed` });
  return risks;
}

runSkill('investor-readiness-audit', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const audit = auditDataRoom(targetDir, argv.stage);
  const risks = assessRisks(audit, argv.stage);

  let readiness = 'not_ready';
  if (audit.completionPercent >= 90) readiness = 'ready';
  else if (audit.completionPercent >= 70) readiness = 'mostly_ready';
  else if (audit.completionPercent >= 50) readiness = 'needs_work';

  const result = {
    directory: targetDir,
    stage: argv.stage,
    readiness,
    completionPercent: audit.completionPercent,
    itemsFound: audit.foundItems,
    itemsRequired: audit.totalItems,
    categories: audit.results,
    risks,
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
