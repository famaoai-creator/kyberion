import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  loadActuatorManifest,
  type ActuatorManifestCapability,
} from '@agent/core/actuator-manifest-index';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import { createBinaryAvailability } from '#binary-availability';
import { evaluateCapabilityContract } from '#capability-discovery-contract';
import { scanActuatorManifests } from './capability-discovery-manifest-scan.mjs';
import {
  assertSafeRepositoryPath,
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
  missingEnv: string[];
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
  envAvailable?: (name: string) => boolean;
}

export function defaultEnvAvailable(name: string): boolean {
  const flag = getRegisteredEnvBool(name);
  if (flag === true) return true;
  if (flag === false) return false;
  return Boolean(getRegisteredEnvText(name));
}

export function evaluateCapability(
  capability: ActuatorManifestCapability,
  platform: NodeJS.Platform,
  binaryAvailable: (bin: string) => boolean,
  envAvailable: (name: string) => boolean = defaultEnvAvailable
): CapabilityDiscoveryCapability {
  return evaluateCapabilityContract(capability, platform, binaryAvailable, envAvailable);
}

const checkBinary = createBinaryAvailability({
  platform: process.platform,
  pathValue: process.env.PATH,
  pathDelimiter: path.delimiter,
  pathExt: process.env.PATHEXT,
  exists: safeExistsSync,
});

export function discoverCapabilities(
  options: CapabilityDiscoveryOptions = {}
): CapabilityDiscoveryReport {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const currentPlatform = options.platform ?? process.platform;
  const binaryAvailable = options.binaryAvailable ?? checkBinary;
  const envAvailable = options.envAvailable ?? defaultEnvAvailable;
  const scan = scanActuatorManifests({
    rootDir,
    actuatorsDir: options.actuatorsDir ?? pathResolver.rootResolve('libs/actuators'),
    io: {
      assertSafePath: assertSafeRepositoryPath,
      exists: safeExistsSync,
      readdir: safeReaddir,
      lstat: safeLstat,
    },
    loadManifest: loadActuatorManifest,
  });
  for (const error of scan.errors) logger.error(error);
  const actuators = scan.actuators.map(({ manifest }) => ({
    actuatorId: manifest.actuator_id,
    version: manifest.version,
    description: manifest.description || 'No description available.',
    capabilities: (manifest.capabilities || []).map((capability) =>
      evaluateCapability(capability, currentPlatform, binaryAvailable, envAvailable)
    ),
  }));
  return { platform: currentPlatform, rootDir, actuators, errors: scan.errors };
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
      const envInfo =
        capability.missingEnv.length > 0
          ? chalk.red(` [Missing env: ${capability.missingEnv.join(', ')}]`)
          : '';
      lines.push(`  ${statusIcon} ${capability.op.padEnd(20)} ${platformInfo}${binInfo}${envInfo}`);
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
