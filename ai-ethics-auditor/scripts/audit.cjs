#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to AI config, prompt, or dataset file',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const BIAS_INDICATORS = [
  { pattern: /\b(gender|sex|male|female|man|woman)\b/gi, category: 'gender', severity: 'medium' },
  {
    pattern: /\b(race|ethnic|black|white|asian|hispanic|latino)\b/gi,
    category: 'racial',
    severity: 'high',
  },
  { pattern: /\b(age|elderly|young|old|senior|junior)\b/gi, category: 'age', severity: 'medium' },
  {
    pattern: /\b(religion|muslim|christian|jewish|hindu|buddhist)\b/gi,
    category: 'religious',
    severity: 'high',
  },
  {
    pattern: /\b(disab|handicap|impair|blind|deaf)\b/gi,
    category: 'disability',
    severity: 'medium',
  },
];
const PRIVACY_RISKS = [
  {
    pattern: /\b(ssn|social.security|passport|license.number)\b/gi,
    category: 'PII Collection',
    severity: 'critical',
  },
  { pattern: /\b(track|fingerprint|beacon|pixel)\b/gi, category: 'Tracking', severity: 'high' },
  {
    pattern: /\b(consent|opt.in|opt.out|gdpr|ccpa)\b/gi,
    category: 'Consent Framework',
    severity: 'info',
    positive: true,
  },
];
const FAIRNESS_CHECKS = [
  {
    pattern: /\b(predict|score|classify|rank)\b.*\b(user|person|applicant|candidate)\b/gi,
    category: 'Algorithmic Decision',
    severity: 'high',
  },
  {
    pattern: /\b(automat|autonomous)\b.*\b(decision|reject|approve|deny)\b/gi,
    category: 'Automated Decision-Making',
    severity: 'critical',
  },
];

function auditContent(content) {
  const findings = { bias: [], privacy: [], fairness: [], transparency: [] };
  for (const rule of BIAS_INDICATORS) {
    const m = content.match(rule.pattern);
    if (m)
      findings.bias.push({
        category: rule.category,
        severity: rule.severity,
        matches: [...new Set(m)].slice(0, 5),
      });
  }
  for (const rule of PRIVACY_RISKS) {
    const m = content.match(rule.pattern);
    if (m)
      findings.privacy.push({
        category: rule.category,
        severity: rule.severity,
        positive: rule.positive || false,
        matches: [...new Set(m)].slice(0, 5),
      });
  }
  for (const rule of FAIRNESS_CHECKS) {
    const m = content.match(rule.pattern);
    if (m)
      findings.fairness.push({
        category: rule.category,
        severity: rule.severity,
        matches: [...new Set(m)].slice(0, 3),
      });
  }
  if (!/\b(explain|interpret|reason|transparent|accountab)\b/i.test(content))
    findings.transparency.push({
      issue: 'No explainability or transparency mentions found',
      severity: 'medium',
    });
  return findings;
}

function calculateEthicsScore(findings) {
  let score = 100;
  score -= findings.bias.filter((f) => f.severity === 'high').length * 10;
  score -= findings.bias.filter((f) => f.severity === 'medium').length * 5;
  score -= findings.privacy.filter((f) => f.severity === 'critical').length * 15;
  score -= findings.privacy.filter((f) => f.severity === 'high').length * 8;
  score += findings.privacy.filter((f) => f.positive).length * 5;
  score -= findings.fairness.filter((f) => f.severity === 'critical').length * 15;
  score -= findings.transparency.length * 5;
  return Math.max(0, Math.min(100, score));
}

runSkill('ai-ethics-auditor', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const content = fs.readFileSync(resolved, 'utf8');
  const findings = auditContent(content);
  const score = calculateEthicsScore(findings);
  let grade = 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 40) grade = 'D';
  const result = {
    source: path.basename(resolved),
    score,
    grade,
    findings,
    totalFindings:
      findings.bias.length +
      findings.privacy.length +
      findings.fairness.length +
      findings.transparency.length,
    recommendations: [
      ...findings.fairness.map((f) => `[${f.severity}] Review ${f.category} for potential harm`),
      ...findings.bias
        .filter((f) => f.severity === 'high')
        .map((f) => `[high] Address ${f.category} bias indicators`),
      ...findings.transparency.map((f) => `[medium] ${f.issue}`),
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
