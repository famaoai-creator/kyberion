#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { getAllFiles } = require('@agent/core/fs-utils');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('locale', { alias: 'l', type: 'string', description: 'Target locale (e.g., ja, fr, de)' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function scanForI18n(dir) {
  const findings = {
    i18nReady: false,
    framework: null,
    localeFiles: [],
    hardcodedStrings: [],
    supportedLocales: [],
  };
  const exists = (p) => fs.existsSync(path.join(dir, p));
  if (exists('i18n') || exists('locales') || exists('translations') || exists('lang')) {
    findings.i18nReady = true;
    const localeDir = ['i18n', 'locales', 'translations', 'lang'].find((d) => exists(d));
    if (localeDir) {
      try {
        const files = fs.readdirSync(path.join(dir, localeDir));
        findings.localeFiles = files;
        findings.supportedLocales = files
          .map((f) => path.basename(f, path.extname(f)))
          .filter((n) => /^[a-z]{2}(-[A-Z]{2})?$/.test(n));
      } catch (_e) {}
    }
  }
  // Check for i18n libraries
  const pkgPath = path.join(dir, 'package.json');
  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      if (deps.some((d) => /i18next|react-intl|vue-i18n|next-intl|formatjs/i.test(d))) {
        findings.framework = deps.find((d) => /i18n/i.test(d));
        findings.i18nReady = true;
      }
    } catch (_e) {}
  }
  // Scan for hardcoded strings in source using common getAllFiles
  const allFiles = getAllFiles(dir, { maxDepth: 3 });
  for (const full of allFiles) {
    if (!['.jsx', '.tsx', '.vue', '.svelte'].includes(path.extname(full))) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      const matches = content.match(/>[\s]*[A-Z][a-z][\w\s]{5,50}[\s]*</g);
      if (matches) {
        findings.hardcodedStrings.push({
          file: path.relative(dir, full),
          count: matches.length,
          samples: matches.slice(0, 3).map((m) => m.replace(/[<>]/g, '').trim()),
        });
      }
    } catch (_e) {}
  }
  return findings;
}

function generateI18nAudit(findings) {
  const issues = [];
  if (!findings.i18nReady)
    issues.push({
      severity: 'high',
      issue: 'No i18n framework or locale files detected',
      recommendation: 'Set up i18next, react-intl, or similar i18n library',
    });
  if (findings.hardcodedStrings.length > 0) {
    const total = findings.hardcodedStrings.reduce((s, f) => s + f.count, 0);
    issues.push({
      severity: 'medium',
      issue: `${total} hardcoded strings found in ${findings.hardcodedStrings.length} files`,
      recommendation: 'Extract strings to locale files',
    });
  }
  if (findings.supportedLocales.length <= 1)
    issues.push({
      severity: 'low',
      issue: 'Only one locale supported',
      recommendation: 'Add translations for target markets',
    });
  return issues;
}

runSkill('localization-maestro', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const findings = scanForI18n(targetDir);
  const audit = generateI18nAudit(findings);
  const readinessScore = findings.i18nReady
    ? findings.hardcodedStrings.length === 0
      ? 100
      : 60
    : 20;
  const result = {
    directory: targetDir,
    targetLocale: argv.locale || null,
    i18nReadiness: {
      score: readinessScore,
      framework: findings.framework,
      supportedLocales: findings.supportedLocales,
      localeFileCount: findings.localeFiles.length,
    },
    hardcodedStrings: findings.hardcodedStrings.slice(0, 20),
    audit,
    recommendations: audit.map((a) => `[${a.severity}] ${a.recommendation}`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
