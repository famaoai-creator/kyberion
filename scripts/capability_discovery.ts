import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { logger, pathResolver, safeExistsSync, safeReaddir, safeReadFile } from '../libs/core/index.js';
import chalk from 'chalk';

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
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function discoverCapabilities() {
  const actuatorsDir = path.join(ROOT_DIR, 'libs/actuators');
  const items = safeReaddir(actuatorsDir);
  const currentPlatform = process.platform;

  console.log(chalk.bold.cyan('\n🔍 [KYBERION] Dynamic Capability Discovery\n'));
  console.log(`Current Platform: ${chalk.yellow(currentPlatform)}`);
  console.log(`Environment Root: ${ROOT_DIR}\n`);

  for (const item of items) {
    const manifestPath = path.join(actuatorsDir, item, 'manifest.json');
    if (!safeExistsSync(manifestPath)) continue;

    try {
      const manifest: ActuatorManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
