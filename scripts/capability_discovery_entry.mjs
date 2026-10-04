#!/usr/bin/env node
/**
 * Build-free actuator discovery. Scans each libs/actuators manifest.json.
 * Used when dist/ is missing or Node cannot load the TypeScript harness
 * (registerHooks requires a newer Node than 22.14).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileBuildFreeSchema } from '#ajv-build-free';
import { createBinaryAvailability } from '#binary-availability';
import { evaluateCapabilityContract } from '#capability-discovery-contract';
import { scanActuatorManifests } from '#capability-discovery-manifest-scan';
import { assertSafeRepositoryPath } from '#repository-path-boundary';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTUATORS_DIR = join(ROOT, 'libs/actuators');
const ACTUATOR_MANIFEST_SCHEMA_PATH = join(
  ROOT,
  'knowledge/product/schemas/actuator-manifest.schema.json'
);
const SAFE_ACTUATOR_MANIFEST_SCHEMA_PATH = assertSafeRepositoryPath(ACTUATOR_MANIFEST_SCHEMA_PATH, {
  rootDir: ROOT,
});
const validateActuatorManifest = compileBuildFreeSchema(
  JSON.parse(readFileSync(SAFE_ACTUATOR_MANIFEST_SCHEMA_PATH, 'utf8'))
);

const binaryAvailable = createBinaryAvailability({
  platform: process.platform,
  pathValue: process.env.PATH,
  pathDelimiter: delimiter,
  pathExt: process.env.PATHEXT,
  exists: existsSync,
});

function envAvailable(name, env = process.env) {
  const value = env[name];
  if (value == null || value === '') return false;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  return true;
}

function evaluateCapability(capability, platform, env = process.env) {
  return evaluateCapabilityContract(capability, platform, binaryAvailable, (name) =>
    envAvailable(name, env)
  );
}

function discoverCapabilities(platform = process.platform) {
  const scan = scanActuatorManifests({
    rootDir: ROOT,
    actuatorsDir: ACTUATORS_DIR,
    io: {
      assertSafePath: assertSafeRepositoryPath,
      exists: existsSync,
      readdir: readdirSync,
      lstat: lstatSync,
    },
    loadManifest(manifestPath) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!validateActuatorManifest(manifest)) {
        const details = (validateActuatorManifest.errors || [])
          .map((error) => (error.instancePath || '/') + ' ' + (error.message || 'is invalid'))
          .join('; ');
        throw new Error('Invalid actuator manifest: ' + details);
      }
      return manifest;
    },
  });
  const actuators = scan.actuators.map(({ manifest }) => ({
    actuatorId: manifest.actuator_id,
    version: manifest.version,
    description: manifest.description || 'No description available.',
    capabilities: (manifest.capabilities || []).map((capability) =>
      evaluateCapability(capability, platform)
    ),
  }));
  return { platform, rootDir: ROOT, actuators, errors: scan.errors };
}

function loadDiscoveryOpCounts() {
  try {
    const discoveryPath = assertSafeRepositoryPath(
      join(ROOT, 'knowledge/product/orchestration/actuator-op-discovery.json'),
      { allowMissingLeaf: true, rootDir: ROOT }
    );
    if (!existsSync(discoveryPath)) return new Map();
    if (!lstatSync(discoveryPath).isFile()) return new Map();
    const parsed = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const map = new Map();
    for (const entry of parsed?.actuators || []) {
      if (entry?.n && Array.isArray(entry.ops)) map.set(entry.n, entry.ops.length);
    }
    return map;
  } catch {
    return new Map();
  }
}

function formatReport(report) {
  const discoveryCounts = loadDiscoveryOpCounts();
  const lines = [
    '',
    '🔍 [KYBERION] Dynamic Capability Discovery',
    '',
    `Current Platform: ${report.platform}`,
    `Environment Root: ${report.rootDir}`,
    'Entry: manifest-scan (no dist/ required)',
    'Note: manifest lists coarse entry points (often just `pipeline`).',
    'Fine-grained step ops live in knowledge/product/orchestration/actuator-op-discovery.json',
    'and CAPABILITIES_GUIDE.md — `pnpm playground --actuator <id> --op <op>` now accepts both.',
    '',
  ];
  for (const actuator of report.actuators) {
    const detailed = discoveryCounts.get(actuator.actuatorId);
    const suffix =
      typeof detailed === 'number' && detailed > actuator.capabilities.length
        ? ` (+${detailed - actuator.capabilities.length} step ops in discovery)`
        : '';
    lines.push(`${actuator.actuatorId} (${actuator.version})${suffix}`);
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
