import * as path from 'node:path';
import { logger, pathResolver, safeExistsSync, safeReaddir, safeExec } from '@agent/core';
import chalk from 'chalk';
import { readJsonFile } from './refactor/cli-input.js';

const ROOT_DIR = pathResolver.rootDir();

interface Capability {
  op: string;
  platforms: string[];
  requirements?: {
    bin?: string[];
    lib?: string[];
  };
}

interface ActuatorManifest {
  actuator_id: string;
  version: string;
  description: string;
  capabilities: Capability[];
}

function checkBinary(bin: string): boolean {
  try {
    safeExec('command', ['-v', bin]);
    return true;
  } catch (_) {
    return false;
  }
}

function discoverCapabilities() {
  const actuatorsDir = pathResolver.rootResolve('libs/actuators');
  const items = safeReaddir(actuatorsDir);
  const currentPlatform = process.platform;

  console.log(chalk.bold.cyan('\n🔍 [KYBERION] Dynamic Capability Discovery\n'));
  console.log(`Current Platform: ${chalk.yellow(currentPlatform)}`);
  console.log(`Environment Root: ${ROOT_DIR}\n`);

  for (const item of items) {
    const manifestPath = path.join(actuatorsDir, item, 'manifest.json');
    if (!safeExistsSync(manifestPath)) continue;

    try {
      const manifest: ActuatorManifest = readJsonFile<ActuatorManifest>(manifestPath);
      console.log(`${chalk.bold.white(manifest.actuator_id)} (${manifest.version})`);
      console.log(`${chalk.dim(manifest.description)}`);

      manifest.capabilities.forEach(cap => {
        const platformMatch = cap.platforms.includes(currentPlatform);
        let requirementsMet = true;
        const missingBins: string[] = [];

        if (cap.requirements?.bin) {
          cap.requirements.bin.forEach(bin => {
            if (!checkBinary(bin)) {
              requirementsMet = false;
              missingBins.push(bin);
            }
          });
        }

        const statusIcon = (platformMatch && requirementsMet) ? chalk.green('✅') : chalk.red('❌');
        const platformInfo = platformMatch ? '' : chalk.red(` [OS Mismatch: ${cap.platforms.join('/')}]`);
        const binInfo = missingBins.length > 0 ? chalk.red(` [Missing: ${missingBins.join(', ')}]`) : '';

        console.log(`  ${statusIcon} ${cap.op.padEnd(20)} ${platformInfo}${binInfo}`);
      });
      console.log('');
    } catch (err: any) {
      logger.error(`Failed to parse manifest for ${item}: ${err.message}`);
    }
  }
}

discoverCapabilities();
