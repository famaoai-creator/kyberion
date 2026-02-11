#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateDirPath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', describe: 'Project directory to audit', demandOption: true })
  .option('out', { alias: 'o', type: 'string', describe: 'Output file path' })
  .argv;

// Restrictive license patterns
const RESTRICTIVE_LICENSES = [
  /\bGPL\b/i,
  /\bAGPL\b/i,
  /\bSSPL\b/i,
  /\bEUPL\b/i,
  /GNU General Public License/i,
  /GNU Affero General Public License/i,
  /Server Side Public License/i,
  /European Union Public License/i,
];

/**
 * Classify a license string as permissive, restrictive, or unknown.
 */
function classifyLicense(licenseStr) {
  if (!licenseStr || licenseStr === 'UNKNOWN') return 'unknown';
  for (const pattern of RESTRICTIVE_LICENSES) {
    if (pattern.test(licenseStr)) return 'restrictive';
  }
  return 'permissive';
}

/**
 * Read license info from a package.json dependency in node_modules.
 */
function readDepLicense(dir, depName) {
  const depPkgPath = path.join(dir, 'node_modules', depName, 'package.json');
  if (fs.existsSync(depPkgPath)) {
    try {
      const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
      return depPkg.license || 'UNKNOWN';
    } catch (_e) {
      return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

runSkill('license-auditor', () => {
  const dirPath = validateDirPath(argv.dir, 'dir');

  // Read the project package.json
  const pkgPath = path.join(dirPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('No package.json found in ' + dirPath);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = Object.entries(pkg.dependencies || {});
  const devDeps = Object.entries(pkg.devDependencies || {});
  const allDeps = [...deps, ...devDeps];

  // Check license field in the project itself
  const projectLicense = pkg.license || 'UNKNOWN';

  // Read LICENSE file if present
  let licenseFile = null;
  const licenseFileCandidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];
  for (const candidate of licenseFileCandidates) {
    const lPath = path.join(dirPath, candidate);
    if (fs.existsSync(lPath)) {
      licenseFile = { name: candidate, content: fs.readFileSync(lPath, 'utf8').slice(0, 2000) };
      break;
    }
  }

  // Scan each dependency
  const packages = allDeps.map(([name, version]) => {
    const license = readDepLicense(dirPath, name);
    const risk = classifyLicense(license);
    return { name, version, license, risk };
  });

  // Build summary
  const summary = {
    total: packages.length,
    permissive: packages.filter(p => p.risk === 'permissive').length,
    restrictive: packages.filter(p => p.risk === 'restrictive').length,
    unknown: packages.filter(p => p.risk === 'unknown').length,
  };

  const result = {
    directory: dirPath,
    projectLicense,
    packages,
    summary,
    licenseFile,
  };

  // Write output if --out provided
  if (argv.out) {
    const outPath = path.resolve(argv.out);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    result.outputPath = outPath;
  }

  return result;
});