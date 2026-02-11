#!/usr/bin/env node
/**
 * supply-chain-sentinel: Software supply chain security - SBoM generation,
 * dependency provenance, and malicious package detection.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('format', { alias: 'f', type: 'string', default: 'cyclonedx', choices: ['cyclonedx', 'spdx', 'json'], description: 'SBoM output format' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const SUSPICIOUS_PATTERNS = [
  { pattern: /postinstall.*curl|wget|fetch/i, risk: 'Network call in postinstall script', severity: 'critical' },
  { pattern: /eval\s*\(\s*(?:Buffer|atob|decode)/i, risk: 'Obfuscated code execution', severity: 'critical' },
  { pattern: /child_process.*exec.*\$/i, risk: 'Dynamic command execution', severity: 'high' },
  { pattern: /process\.env\.(AWS|SECRET|TOKEN|KEY|PASSWORD)/i, risk: 'Credential access', severity: 'medium' },
];

function generateSBoM(dir) {
  const components = [];
  // Node.js dependencies
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [name, version] of Object.entries(allDeps)) {
      components.push({ type: 'library', name, version: version.replace(/[\^~>=<]/g, ''), ecosystem: 'npm', scope: pkg.dependencies?.[name] ? 'required' : 'development' });
    }
  }
  // Python dependencies
  const reqPath = path.join(dir, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    const lines = fs.readFileSync(reqPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
    for (const line of lines) {
      const m = line.match(/^([a-zA-Z0-9_-]+)(?:[=<>!]+(.+))?/);
      if (m) components.push({ type: 'library', name: m[1], version: m[2] || 'latest', ecosystem: 'pypi', scope: 'required' });
    }
  }
  return components;
}

function checkProvenance(components) {
  const concerns = [];
  for (const comp of components) {
    // Check for typosquatting patterns
    const knownPkgs = ['express', 'lodash', 'react', 'axios', 'moment', 'webpack', 'babel', 'jest', 'mocha', 'chalk'];
    for (const known of knownPkgs) {
      if (comp.name !== known && comp.name.includes(known) && comp.name.length <= known.length + 3) {
        concerns.push({ package: comp.name, risk: 'typosquatting', detail: `Similar to known package "${known}"`, severity: 'high' });
      }
    }
    // Check for version pinning
    if (comp.version === 'latest' || comp.version === '*') {
      concerns.push({ package: comp.name, risk: 'unpinned_version', detail: 'Using unpinned version - vulnerable to supply chain attacks', severity: 'medium' });
    }
  }
  return concerns;
}

function scanForMalicious(dir) {
  const findings = [];
  function walk(d, depth) {
    if (depth > 3) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full, depth+1); continue; }
        if (!['.js','.cjs','.mjs','.sh'].includes(path.extname(e.name))) continue;
        try {
          const content = fs.readFileSync(full, 'utf8');
          for (const rule of SUSPICIOUS_PATTERNS) {
            if (rule.pattern.test(content)) {
              findings.push({ file: path.relative(dir, full), risk: rule.risk, severity: rule.severity });
            }
          }
        } catch(_e){}
      }
    } catch(_e){}
  }
  walk(dir, 0);
  return findings;
}

function formatCycloneDX(components, projectName) {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { type: 'application', name: projectName }, timestamp: new Date().toISOString() },
    components: components.map(c => ({ type: c.type, name: c.name, version: c.version, purl: `pkg:${c.ecosystem}/${c.name}@${c.version}` })),
  };
}

function formatSPDX(components, projectName) {
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', name: projectName,
    documentNamespace: `https://spdx.org/spdxdocs/${projectName}`,
    packages: components.map(c => ({ name: c.name, versionInfo: c.version, downloadLocation: 'NOASSERTION', supplier: 'NOASSERTION' })),
  };
}

runSkill('supply-chain-sentinel', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const pkgPath = path.join(targetDir, 'package.json');
  const projectName = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath,'utf8')).name || 'unknown' : 'unknown';

  const components = generateSBoM(targetDir);
  const provenance = checkProvenance(components);
  const malicious = scanForMalicious(targetDir);

  let sbom;
  if (argv.format === 'cyclonedx') sbom = formatCycloneDX(components, projectName);
  else if (argv.format === 'spdx') sbom = formatSPDX(components, projectName);
  else sbom = { components };

  const riskScore = Math.min(100, provenance.filter(p=>p.severity==='critical').length * 30 + provenance.filter(p=>p.severity==='high').length * 15 + malicious.filter(m=>m.severity==='critical').length * 40 + malicious.filter(m=>m.severity==='high').length * 20);

  const result = {
    project: projectName, directory: targetDir, format: argv.format,
    componentCount: components.length,
    riskScore, riskLevel: riskScore >= 50 ? 'critical' : riskScore >= 20 ? 'elevated' : 'low',
    provenanceConcerns: provenance, maliciousFindings: malicious, sbom,
    recommendations: [
      ...provenance.slice(0,3).map(p => `[${p.severity}] ${p.package}: ${p.detail}`),
      ...malicious.slice(0,3).map(m => `[${m.severity}] ${m.file}: ${m.risk}`),
    ],
  };

  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
