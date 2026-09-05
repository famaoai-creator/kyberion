import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  loadActuatorManifest,
  type ActuatorManifestCapability,
} from '@agent/core/actuator-manifest-index';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import chalk from 'chalk';
import { defineScript, isDirectScript } from './lib/harness.js';

const ROOT_DIR = pathResolver.rootDir();

export interface CapabilityDiscoveryCapability {
  op: string;
  platforms: string[];
  platformMatch: boolean;
  missingBins: string[];
  available: boolean;
}

export interface CapabilityDiscoveryActuator {
  actuatorId: string;
  version: string;
  description: string;
  capabilities: CapabilityDiscoveryCapability[];
}

export interface CapabilityDiscoveryReport {
  platform: NodeJS.Platform;
  rootDir: string;
  actuators: CapabilityDiscoveryActuator[];
  errors: string[];
}

export interface CapabilityDiscoveryOptions {
  actuatorsDir?: string;
  rootDir?: string;
  platform?: NodeJS.Platform;
  binaryAvailable?: (bin: string) => boolean;
}

export function evaluateCapability(
  capability: ActuatorManifestCapability,
  platform: NodeJS.Platform,
  binaryAvailable: (bin: string) => boolean
): CapabilityDiscoveryCapability {
  const platformMatch = capability.platforms.includes(platform);
  const missingBins = (capability.requirements?.bin ?? []).filter((bin) => !binaryAvailable(bin));
  return {
    op: capability.op,
    platforms: capability.platforms,
    platformMatch,
    missingBins,
    available: platformMatch && missingBins.length === 0,
  };
}

function checkBinary(bin: string): boolean {
  try {
    safeExec('command', ['-v', bin]);
    return true;
  } catch (_) {
    return false;
  }
}

export function discoverCapabilities(
  options: CapabilityDiscoveryOptions = {}
): CapabilityDiscoveryReport {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const actuatorsDir = assertSafeRepositoryPath(
    options.actuatorsDir ?? pathResolver.rootResolve('libs/actuators'),
    { allowMissingLeaf: false, rootDir }
  );
  const items = safeReaddir(actuatorsDir);
  const currentPlatform = options.platform ?? process.platform;
  const binaryAvailable = options.binaryAvailable ?? checkBinary;
  const actuators: CapabilityDiscoveryActuator[] = [];
  const errors: string[] = [];

  for (const item of items) {
    let manifestPath: string;
    try {
      manifestPath = assertSafeRepositoryPath(path.join(actuatorsDir, item, 'manifest.json'), {
        allowMissingLeaf: false,
        rootDir,
      });
    } catch {
      continue;
    }
    if (!safeExistsSync(manifestPath) || !safeLstat(manifestPath).isFile()) continue;

    try {
      const manifest = loadActuatorManifest(manifestPath);
      actuators.push({
        actuatorId: manifest.actuator_id,
        version: manifest.version,
        description: manifest.description || 'No description available.',
        capabilities: (manifest.capabilities || []).map((capability) =>
          evaluateCapability(capability, currentPlatform, binaryAvailable)
        ),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const error = `Failed to parse manifest for ${item}: ${message}`;
      errors.push(error);
      logger.error(error);
    }
  }

  return { platform: currentPlatform, rootDir, actuators, errors };
}

export function formatCapabilityDiscovery(report: CapabilityDiscoveryReport): string {
  const lines = [
    '\n🔍 [KYBERION] Dynamic Capability Discovery\n',
    `Current Platform: ${chalk.yellow(report.platform)}`,
    `Environment Root: ${report.rootDir}\n`,
  ];

  for (const actuator of report.actuators) {
    lines.push(`${chalk.bold.white(actuator.actuatorId)} (${actuator.version})`);
    lines.push(chalk.dim(actuator.description));
    for (const capability of actuator.capabilities) {
      const statusIcon = capability.available ? chalk.green('✅') : chalk.red('❌');
      const platformInfo = capability.platformMatch
        ? ''
        : chalk.red(` [OS Mismatch: ${capability.platforms.join('/')}]`);
      const binInfo =
        capability.missingBins.length > 0
          ? chalk.red(` [Missing: ${capability.missingBins.join(', ')}]`)
          : '';
      lines.push(`  ${statusIcon} ${capability.op.padEnd(20)} ${platformInfo}${binInfo}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export const runCapabilityDiscovery = defineScript({
  name: 'capabilities',
  run(context) {
    const report = discoverCapabilities();
    context.print(context.json ? report : formatCapabilityDiscovery(report));
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'capability_discovery.ts') ||
  isDirectScript(import.meta.url, 'capability_discovery.js')
)
  void runCapabilityDiscovery();
