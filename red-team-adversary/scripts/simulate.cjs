#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('scope', { alias: 's', type: 'string', default: 'recon', choices: ['recon', 'static', 'full'], description: 'Assessment scope' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const ATTACK_VECTORS = [
  { id: 'hardcoded-secrets', pattern: /(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]{8,}/gi, severity: 'critical', category: 'Credential Exposure' },
  { id: 'sql-injection', pattern: /(?:query|execute|raw)\s*\(\s*[`'"].*\$\{|(?:\+\s*req\.|concat)/gi, severity: 'critical', category: 'SQL Injection' },
  { id: 'xss', pattern: /innerHTML\s*=|dangerouslySetInnerHTML|document\.write/gi, severity: 'high', category: 'Cross-Site Scripting' },
  { id: 'command-injection', pattern: /exec\s*\(\s*[`'"].*\$\{|execSync.*\+/gi, severity: 'critical', category: 'Command Injection' },
  { id: 'path-traversal', pattern: /(?:readFile|createReadStream)\s*\(.*(?:req\.|params\.|query\.)/gi, severity: 'high', category: 'Path Traversal' },
  { id: 'insecure-random', pattern: /Math\.random\(\)/g, severity: 'medium', category: 'Weak Randomness' },
  { id: 'no-csrf', pattern: /app\.(post|put|delete)\s*\(/gi, severity: 'medium', category: 'Missing CSRF Protection' },
  { id: 'debug-mode', pattern: /debug\s*[:=]\s*true|NODE_ENV.*development/gi, severity: 'medium', category: 'Debug Mode Exposure' },
];

function performRecon(dir) {
  const recon = { publicEndpoints: [], configFiles: [], sensitiveFiles: [] };
  function walk(d, depth) {
    if (depth > 3) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        const rel = path.relative(dir, full);
        if (/\.env|credentials|secrets|\.pem|\.key$/i.test(e.name)) recon.sensitiveFiles.push(rel);
        if (/config|setting/i.test(e.name) && /\.(json|yml|yaml|toml)$/.test(e.name)) recon.configFiles.push(rel);
        if (/routes|controller|handler|endpoint/i.test(e.name)) recon.publicEndpoints.push(rel);
      }
    } catch(_e){}
  }
  walk(dir, 0);
  return recon;
}

function staticAnalysis(dir) {
  const vulnerabilities = [];
  function walk(d, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!['.js','.cjs','.ts','.tsx','.jsx'].includes(path.extname(e.name))) continue;
        try {
          const content = fs.readFileSync(full, 'utf8');
          for (const vector of ATTACK_VECTORS) {
            const matches = content.match(vector.pattern);
            if (matches) vulnerabilities.push({ file: path.relative(dir, full), vector: vector.id, category: vector.category, severity: vector.severity, occurrences: matches.length });
          }
        } catch(_e){}
      }
    } catch(_e){}
  }
  walk(dir, 0);
  return vulnerabilities;
}

runSkill('red-team-adversary', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const recon = performRecon(targetDir);
  const vulns = argv.scope !== 'recon' ? staticAnalysis(targetDir) : [];
  const criticalCount = vulns.filter(v => v.severity === 'critical').length;
  const result = {
    directory: targetDir, scope: argv.scope,
    reconnaissance: recon, vulnerabilities: vulns.slice(0, 30), vulnerabilityCount: vulns.length,
    riskLevel: criticalCount > 0 ? 'critical' : vulns.length > 5 ? 'high' : vulns.length > 0 ? 'medium' : 'low',
    attackSurface: { endpoints: recon.publicEndpoints.length, configFiles: recon.configFiles.length, sensitiveFiles: recon.sensitiveFiles.length },
    recommendations: [
      ...recon.sensitiveFiles.slice(0, 3).map(f => `[critical] Sensitive file exposed: ${f}`),
      ...vulns.filter(v => v.severity === 'critical').slice(0, 3).map(v => `[critical] ${v.category} in ${v.file}`),
    ],
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
