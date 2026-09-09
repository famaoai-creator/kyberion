#!/usr/bin/env node
/**
 * Build-free actuator discovery. Scans each libs/actuators manifest.json.
 * Used when dist/ is missing or Node cannot load the TypeScript harness
 * (registerHooks requires a newer Node than 22.14).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTUATORS_DIR = join(ROOT, 'libs/actuators');

function binaryAvailable(bin) {
  const result = spawnSync('command', ['-v', bin], { encoding: 'utf8' });
  return result.status === 0;
}

function envAvailable(name, env = process.env) {
  const value = env[name];
  if (value == null || value === '') return false;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  return true;
}

function envRequirementsApply(capability, platform) {
  const envPlatforms = capability.requirements?.env_platforms;
  return !envPlatforms || envPlatforms.length === 0 || envPlatforms.includes(platform);
}

function evaluateCapability(capability, platform, env = process.env) {
  const platforms = Array.isArray(capability.platforms) ? capability.platforms : [];
  const requiredBins = capability.requirements?.bin ?? [];
  const requiredEnv = capability.requirements?.env ?? [];
  const platformMatch = platforms.length === 0 || platforms.includes(platform);
  const missingBins = requiredBins.filter((bin) => !binaryAvailable(bin));
  const missingEnv = envRequirementsApply(capability, platform)
    ? requiredEnv.filter((name) => !envAvailable(name, env))
    : [];
  return {
    op: String(capability.op || ''),
    platforms,
    platformMatch,
    missingBins,
    missingEnv,
    available: platformMatch && missingBins.length === 0 && missingEnv.length === 0,
  };
}

function discoverCapabilities(platform = process.platform) {
  const actuators = [];
  const errors = [];
  if (!existsSync(ACTUATORS_DIR)) {
    return { platform, rootDir: ROOT, actuators, errors: [`missing ${ACTUATORS_DIR}`] };
  }

  for (const item of readdirSync(ACTUATORS_DIR)) {
    const dir = join(ACTUATORS_DIR, item);
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      actuators.push({
        actuatorId: manifest.actuator_id || item,
        version: manifest.version || '',
        description: manifest.description || 'No description available.',
        capabilities: (manifest.capabilities || []).map((capability) =>
          evaluateCapability(capability, platform)
        ),
      });
    } catch (err) {
      errors.push(`Failed to parse manifest for ${item}: ${err.message || err}`);
    }
  }

  actuators.sort((a, b) => a.actuatorId.localeCompare(b.actuatorId));
  return { platform, rootDir: ROOT, actuators, errors };
}

function formatReport(report) {
  const lines = [
    '',
    '🔍 [KYBERION] Dynamic Capability Discovery',
    '',
    `Current Platform: ${report.platform}`,
    `Environment Root: ${report.rootDir}`,
    'Entry: manifest-scan (no dist/ required)',
    '',
  ];
  for (const actuator of report.actuators) {
    lines.push(`${actuator.actuatorId} (${actuator.version})`);
    lines.push(actuator.description);
    for (const capability of actuator.capabilities) {
      const icon = capability.available ? '✅' : '❌';
      const platformInfo = capability.platformMatch
        ? ''
        : ` [OS Mismatch: ${capability.platforms.join('/')}]`;
      const binInfo =
        capability.missingBins.length > 0 ? ` [Missing: ${capability.missingBins.join(', ')}]` : '';
      const envInfo =
        capability.missingEnv.length > 0
          ? ` [Missing env: ${capability.missingEnv.join(', ')}]`
          : '';
      lines.push(`  ${icon} ${capability.op.padEnd(20)} ${platformInfo}${binInfo}${envInfo}`);
    }
    lines.push('');
  }
  if (report.errors.length > 0) {
    lines.push('Errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }
  return lines.join('\n');
}

export { discoverCapabilities, evaluateCapability, formatReport };

function isDirectEntry() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return fileURLToPath(import.meta.url) === resolve(invoked);
}

if (isDirectEntry()) {
  const report = discoverCapabilities();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  if (report.errors.length > 0) process.exitCode = 1;
}
