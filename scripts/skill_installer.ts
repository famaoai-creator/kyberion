import {
  loadCapabilityBundleRegistry,
  scanProviderCapabilities,
  loadProviderCapabilityScanPolicy,
  safeExec,
  type CapabilityBundleEntry,
  type DiscoveredCapability
} from '@agent/core';
import * as readline from 'node:readline';
import chalk from 'chalk';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function checkBinary(bin: string): boolean {
  try {
    safeExec('command', ['-v', bin]);
    return true;
  } catch (_) {
    return false;
  }
}

async function installPackage(type: 'brew' | 'pip', name: string): Promise<boolean> {
  console.log(chalk.yellow(`\n⚡ Installing ${name} via ${type}...`));
  try {
    if (type === 'brew') {
      safeExec('brew', ['install', name]);
    } else if (type === 'pip') {
      safeExec('pip3', ['install', name]);
    }
    console.log(chalk.green(`✓ Successfully installed ${name}!`));
    return true;
  } catch (err: any) {
    console.error(chalk.red(`❌ Failed to install ${name}: ${err.message}`));
    return false;
  }
}

async function runInstaller() {
  console.log(chalk.bold.cyan('\n📦 [KYBERION] Interactive Skill Installer\n'));

  const registry = loadCapabilityBundleRegistry();
  const args = process.argv.slice(2);
  let targetBundleId = args[0];

  if (!targetBundleId) {
    console.log(chalk.white('Available Skill Bundles:'));
    registry.bundles.forEach(bundle => {
      const statusColor = bundle.status === 'active' ? chalk.green : chalk.yellow;
      console.log(`  - ${chalk.bold(bundle.bundle_id)} [${statusColor(bundle.status)}] - ${bundle.summary}`);
    });

    targetBundleId = await question(chalk.bold.blue('\nEnter a Bundle ID to install: '));
  }

  const bundle = registry.bundles.find(b => b.bundle_id === targetBundleId);
  if (!bundle) {
    console.error(chalk.red(`\n❌ Bundle ID '${targetBundleId}' not found in registry.`));
    rl.close();
    process.exit(1);
  }

  console.log(chalk.white(`\nAnalyzing requirements for skill bundle: ${chalk.bold.magenta(bundle.bundle_id)}...`));

  // Run dynamic capability scan
  const allCapabilities = scanProviderCapabilities(undefined, undefined, { includeUnavailable: true });
  const requiredRefs = bundle.harness_capability_refs || [];

  const neededCapabilities = allCapabilities.filter(c => requiredRefs.includes(c.capability_id));
  const missingCapabilities = neededCapabilities.filter(c => c.discovery_status === 'missing');

  if (neededCapabilities.length === 0) {
    console.log(chalk.green('\n✓ No external runtime capabilities required. Skill is ready!'));
    rl.close();
    process.exit(0);
  }

  console.log(chalk.white('\nRequired Capabilities Status:'));
  neededCapabilities.forEach(c => {
    const statusIcon = c.discovery_status === 'available' ? chalk.green('✅ Available') : chalk.red('❌ Missing');
    console.log(`  - ${c.capability_id} [${statusIcon}] (${c.source.provider})`);
  });

  if (missingCapabilities.length === 0) {
    console.log(chalk.bold.green('\n🎉 All required capabilities are already satisfied. Skill is fully active!'));
    rl.close();
    process.exit(0);
  }

  console.log(chalk.yellow(`\n⚠️  ${missingCapabilities.length} missing capability/dependencies detected.`));

  for (const cap of missingCapabilities) {
    console.log(chalk.white(`\nResolving dependency for: ${chalk.bold.yellow(cap.capability_id)}`));

    // Deduce package name based on provider or id
    let installType: 'brew' | 'pip' | null = null;
    let packageName = '';

    if (cap.capability_id.includes('whisper')) {
      installType = 'pip';
      packageName = 'faster-whisper';
    } else if (cap.capability_id.includes('ffmpeg')) {
      installType = 'brew';
      packageName = 'ffmpeg';
    } else if (cap.source.provider === 'hermes-agent' || cap.capability_id.includes('hermes')) {
      installType = 'brew';
      packageName = 'sox'; // Hermes audio pipeline often uses sox
    } else if (cap.capability_id.includes('gh')) {
      installType = 'brew';
      packageName = 'gh';
    }

    if (installType && packageName) {
      const ans = await question(chalk.bold.blue(`Would you like Kyberion to install '${packageName}' via ${installType}? [Y/n]: `));
      if (ans.toLowerCase() !== 'n') {
        const success = await installPackage(installType, packageName);
        if (success) {
          cap.discovery_status = 'available';
        }
      }
    } else {
      console.log(chalk.red(`Could not deduce auto-installer for ${cap.capability_id}. Please install it manually.`));
    }
  }

  // Final verification check
  console.log(chalk.white('\nVerifying post-installation state...'));
  const finalCapabilities = scanProviderCapabilities();
  const finalMissing = finalCapabilities.filter(c => requiredRefs.includes(c.capability_id) && c.discovery_status === 'missing');

  if (finalMissing.length === 0) {
    console.log(chalk.bold.green(`\n🎉 Success! All dependencies resolved. Skill '${bundle.bundle_id}' is now fully ACTIVE!`));
  } else {
    console.log(chalk.yellow(`\n⚠️  Installation finished, but some capabilities remain unresolved.`));
  }

  rl.close();
}

runInstaller().catch(err => {
  console.error(chalk.red(`\n❌ Error: ${err.message}`));
  rl.close();
  process.exit(1);
});
