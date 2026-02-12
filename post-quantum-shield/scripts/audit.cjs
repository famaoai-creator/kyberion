#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const VULNERABLE_CRYPTO = [
  { pattern: /\b(RSA|rsa)\b/g, algorithm: 'RSA', risk: 'high', replacement: 'ML-KEM (CRYSTALS-Kyber)' },
  { pattern: /\b(ECDSA|ecdsa|secp256k1|secp384r1|P-256|P-384)\b/g, algorithm: 'ECDSA/ECC', risk: 'high', replacement: 'ML-DSA (CRYSTALS-Dilithium)' },
  { pattern: /\b(Diffie.Hellman|DH|ECDH|ecdh)\b/gi, algorithm: 'Diffie-Hellman/ECDH', risk: 'high', replacement: 'ML-KEM' },
  { pattern: /\b(DSA|dsa)\b/g, algorithm: 'DSA', risk: 'high', replacement: 'ML-DSA' },
  { pattern: /\b(AES-128|aes128)\b/gi, algorithm: 'AES-128', risk: 'medium', replacement: 'AES-256 (Grover resistance)' },
  { pattern: /\b(MD5|md5)\b/g, algorithm: 'MD5', risk: 'critical', replacement: 'SHA-3 or SHAKE' },
  { pattern: /\b(SHA-1|sha1)\b/gi, algorithm: 'SHA-1', risk: 'critical', replacement: 'SHA-3 or SHA-256+' },
];

function scanCrypto(dir) {
  const findings = [];
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    if (!['.js', '.cjs', '.ts', '.py', '.go', '.rs', '.java', '.rb', '.yml', '.yaml', '.json', '.toml', '.cfg'].includes(path.extname(full))) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      for (const vuln of VULNERABLE_CRYPTO) {
        const matches = content.match(vuln.pattern);
        if (matches) findings.push({ file: path.relative(dir, full), algorithm: vuln.algorithm, risk: vuln.risk, pqcReplacement: vuln.replacement, occurrences: matches.length });
      }
    } catch (_e) {}
  }
  return findings;
}

function assessMigrationEffort(findings) {
  const byAlgorithm = {};
  for (const f of findings) {
    if (!byAlgorithm[f.algorithm]) byAlgorithm[f.algorithm] = { files: 0, occurrences: 0, replacement: f.pqcReplacement, risk: f.risk };
    byAlgorithm[f.algorithm].files++;
    byAlgorithm[f.algorithm].occurrences += f.occurrences;
  }
  const effort = Object.entries(byAlgorithm).map(([algo, data]) => ({
    algorithm: algo, ...data,
    estimatedEffort: data.files > 10 ? 'high' : data.files > 3 ? 'medium' : 'low',
  }));
  return effort.sort((a, b) => { const r = { critical: 0, high: 1, medium: 2 }; return (r[a.risk] || 3) - (r[b.risk] || 3); });
}

runSkill('post-quantum-shield', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const findings = scanCrypto(targetDir);
  const migration = assessMigrationEffort(findings);
  const riskScore = findings.reduce((s, f) => s + (f.risk === 'critical' ? 30 : f.risk === 'high' ? 15 : 5), 0);
  const result = {
    directory: targetDir, quantumVulnerable: findings.length > 0,
    riskScore: Math.min(100, riskScore), findings: findings.slice(0, 30), findingCount: findings.length,
    migrationPlan: migration,
    recommendations: migration.slice(0, 5).map(m => `[${m.risk}] Replace ${m.algorithm} with ${m.replacement} (${m.files} files, effort: ${m.estimatedEffort})`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
