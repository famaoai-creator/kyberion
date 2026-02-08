#!/usr/bin/env node
/**
 * ux-auditor: Performs structural UX/Accessibility audits on web projects.
 * Analyzes HTML files for accessibility issues, consistency, and usability heuristics.
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

const argv = yargs(hideBin(process.argv))
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Directory to audit for UX issues',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

// --- UX Heuristic Rules ---

const HEURISTICS = {
  accessibility: {
    name: 'Accessibility',
    weight: 30,
    checks: [
      { id: 'img-alt', pattern: /<img(?![^>]*alt=)/gi, severity: 'error', message: 'Image missing alt attribute' },
      { id: 'input-label', pattern: /<input(?![^>]*aria-label)(?![^>]*id=)/gi, severity: 'warning', message: 'Input may lack associated label' },
      { id: 'lang-attr', pattern: /<html(?![^>]*lang=)/gi, severity: 'error', message: 'HTML tag missing lang attribute' },
      { id: 'heading-order', pattern: null, custom: 'checkHeadingOrder', severity: 'warning', message: 'Heading hierarchy may be incorrect' },
    ],
  },
  forms: {
    name: 'Form Usability',
    weight: 20,
    checks: [
      { id: 'form-action', pattern: /<form(?![^>]*action=)/gi, severity: 'warning', message: 'Form missing explicit action attribute' },
      { id: 'submit-btn', pattern: null, custom: 'checkSubmitButton', severity: 'warning', message: 'Form may lack a submit button' },
      { id: 'placeholder-only', pattern: /<input[^>]*placeholder=[^>]*(?!.*(?:label|aria-label))/gi, severity: 'info', message: 'Input uses placeholder without label (placeholder is not a label substitute)' },
    ],
  },
  navigation: {
    name: 'Navigation & Structure',
    weight: 20,
    checks: [
      { id: 'nav-element', pattern: /<nav/gi, severity: 'info', message: 'Navigation landmark found', positive: true },
      { id: 'main-element', pattern: /<main/gi, severity: 'info', message: 'Main content landmark found', positive: true },
      { id: 'skip-link', pattern: /skip.*(nav|content|main)/gi, severity: 'info', message: 'Skip navigation link found', positive: true },
    ],
  },
  performance: {
    name: 'Performance Hints',
    weight: 15,
    checks: [
      { id: 'large-inline-style', pattern: /style="[^"]{200,}"/gi, severity: 'warning', message: 'Large inline style detected - consider external CSS' },
      { id: 'blocking-script', pattern: /<script(?![^>]*(?:async|defer))[^>]*src=/gi, severity: 'info', message: 'Render-blocking script without async/defer' },
    ],
  },
  responsive: {
    name: 'Responsive Design',
    weight: 15,
    checks: [
      { id: 'viewport-meta', pattern: /<meta[^>]*viewport/gi, severity: 'error', message: 'Missing viewport meta tag', positive: true },
      { id: 'fixed-width', pattern: /width:\s*\d{4,}px/gi, severity: 'warning', message: 'Fixed pixel width over 1000px detected' },
    ],
  },
};

function findHtmlFiles(dir, maxDepth, depth) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findHtmlFiles(full, maxDepth, depth + 1));
      } else if (entry.name.match(/\.(html?|ejs|hbs|jsx|tsx|vue|svelte)$/i)) {
        results.push(full);
      }
    }
  } catch (_e) { /* skip unreadable dirs */ }
  return results;
}

function checkHeadingOrder(content) {
  const headings = [];
  const re = /<h([1-6])/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    headings.push(parseInt(m[1]));
  }
  const issues = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) {
      issues.push(`Heading jumps from h${headings[i - 1]} to h${headings[i]}`);
    }
  }
  return issues;
}

function checkSubmitButton(content) {
  const formCount = (content.match(/<form/gi) || []).length;
  const submitCount = (content.match(/type=["']submit["']/gi) || []).length;
  const buttonSubmit = (content.match(/<button(?![^>]*type=["']button["'])/gi) || []).length;
  if (formCount > 0 && submitCount === 0 && buttonSubmit === 0) {
    return ['Form present but no submit button found'];
  }
  return [];
}

const CUSTOM_CHECKS = { checkHeadingOrder, checkSubmitButton };

function auditFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const findings = [];

  for (const [_category, config] of Object.entries(HEURISTICS)) {
    for (const check of config.checks) {
      if (check.pattern) {
        const matches = content.match(check.pattern);
        if (check.positive) {
          if (matches && matches.length > 0) {
            findings.push({ id: check.id, severity: 'pass', message: check.message, count: matches.length });
          }
        } else if (matches && matches.length > 0) {
          findings.push({ id: check.id, severity: check.severity, message: check.message, count: matches.length });
        }
      }
      if (check.custom && CUSTOM_CHECKS[check.custom]) {
        const issues = CUSTOM_CHECKS[check.custom](content);
        for (const issue of issues) {
          findings.push({ id: check.id, severity: check.severity, message: issue });
        }
      }
    }
  }

  return findings;
}

function calculateScore(allFindings) {
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const [_key, config] of Object.entries(HEURISTICS)) {
    totalWeight += config.weight;
    const categoryIds = config.checks.map(c => c.id);
    const categoryFindings = allFindings.filter(f => categoryIds.includes(f.id));
    const errors = categoryFindings.filter(f => f.severity === 'error').length;
    const warnings = categoryFindings.filter(f => f.severity === 'warning').length;
    const passes = categoryFindings.filter(f => f.severity === 'pass').length;

    const deduction = errors * 0.3 + warnings * 0.1;
    const bonus = passes * 0.1;
    const score = Math.max(0, Math.min(1, 1 - deduction + bonus));
    earnedWeight += config.weight * score;
  }

  return Math.round((earnedWeight / totalWeight) * 100);
}

runSkill('ux-auditor', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const files = findHtmlFiles(targetDir, 5, 0);
  const fileResults = [];
  const allFindings = [];

  for (const file of files) {
    const findings = auditFile(file);
    allFindings.push(...findings);
    if (findings.length > 0) {
      fileResults.push({
        file: path.relative(targetDir, file),
        findings,
      });
    }
  }

  const score = files.length > 0 ? calculateScore(allFindings) : 100;
  let grade = 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 40) grade = 'D';

  const errorCount = allFindings.filter(f => f.severity === 'error').length;
  const warningCount = allFindings.filter(f => f.severity === 'warning').length;
  const infoCount = allFindings.filter(f => f.severity === 'info').length;

  const recommendations = [];
  if (errorCount > 0) recommendations.push(`Fix ${errorCount} accessibility errors (alt tags, lang attributes, viewport)`);
  if (warningCount > 0) recommendations.push(`Address ${warningCount} usability warnings`);
  if (files.length === 0) recommendations.push('No HTML-like files found in the target directory');

  const result = {
    directory: targetDir,
    filesScanned: files.length,
    score,
    grade,
    summary: { errors: errorCount, warnings: warningCount, info: infoCount },
    recommendations,
    details: fileResults,
  };

  if (argv.out) {
    fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
