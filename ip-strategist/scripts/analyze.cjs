#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory to analyze' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const IP_INDICATORS = [
  { pattern: /(?:algorithm|heuristic|model|neural|machine.learning|deep.learning)/gi, category: 'Algorithm/Model', patentable: true },
  { pattern: /(?:patent|trademark|copyright|intellectual.property)/gi, category: 'IP Reference', patentable: false },
  { pattern: /(?:proprietary|trade.secret|confidential|novel)/gi, category: 'Trade Secret', patentable: false },
  { pattern: /(?:unique|innovative|first.of.its.kind|breakthrough)/gi, category: 'Innovation Claim', patentable: true },
  { pattern: /(?:protocol|specification|standard|format)/gi, category: 'Protocol/Standard', patentable: true },
];

function scanForIP(dir) {
  const findings = [];
  const allFiles = getAllFiles(dir, { maxDepth: 4 });
  for (const full of allFiles) {
    if (!['.js', '.cjs', '.ts', '.py', '.go', '.rs', '.java', '.md'].includes(path.extname(full))) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      for (const indicator of IP_INDICATORS) {
        const matches = content.match(indicator.pattern);
        if (matches && matches.length > 0) {
          findings.push({ file: path.relative(dir, full), category: indicator.category, patentable: indicator.patentable, matchCount: matches.length, samples: [...new Set(matches)].slice(0, 3) });
        }
      }
    } catch (_e) {}
  }
  return findings;
}

function checkLicenseProtection(dir) {
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENCE'].find(f => fs.existsSync(path.join(dir, f)));
  if (!licenseFile) return { protected: false, license: null, risk: 'high' };
  const content = fs.readFileSync(path.join(dir, licenseFile), 'utf8');
  let type = 'unknown';
  if (/MIT/i.test(content)) type = 'MIT (permissive)';
  else if (/Apache/i.test(content)) type = 'Apache 2.0 (permissive with patent grant)';
  else if (/GPL/i.test(content)) type = 'GPL (copyleft)';
  else if (/BSD/i.test(content)) type = 'BSD (permissive)';
  else if (/proprietary|all rights reserved/i.test(content)) type = 'Proprietary';
  return { protected: true, license: type, file: licenseFile, risk: type.includes('permissive') ? 'medium' : 'low' };
}

runSkill('ip-strategist', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const findings = scanForIP(targetDir);
  const license = checkLicenseProtection(targetDir);
  const patentable = findings.filter(f => f.patentable);
  const result = {
    directory: targetDir, totalFindings: findings.length,
    patentableItems: patentable.length, findings: findings.slice(0, 30),
    licenseProtection: license,
    ipPortfolio: {
      algorithms: findings.filter(f => f.category === 'Algorithm/Model').length,
      protocols: findings.filter(f => f.category === 'Protocol/Standard').length,
      tradeSecrets: findings.filter(f => f.category === 'Trade Secret').length,
    },
    recommendations: [
      !license.protected ? '[critical] No LICENSE file - IP is unprotected' : `License: ${license.license}`,
      patentable.length > 0 ? `[high] ${patentable.length} potentially patentable items found - consider IP review` : 'No patentable algorithms detected',
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
