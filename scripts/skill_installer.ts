import { loadCapabilityBundleRegistry } from '@agent/core/capability-bundle-registry';
import { scanProviderCapabilities } from '@agent/core/provider-capability-scanner';
import { safeExec } from '@agent/core/secure-io';
import { findSkillInstallPackageMapEntry } from '@agent/core/skill-install-package-map';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function printUsage(): void {
  console.log(chalk.bold.cyan('\n📦 [KYBERION] Interactive Skill Installer\n'));
  console.log('Usage: pnpm skill:install <bundle-id>');
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

async function runInstaller(args: string[]) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const registry = loadCapabilityBundleRegistry();
    let targetBundleId = args[0];

    if (targetBundleId === '--help' || targetBundleId === '-h') {
      printUsage();
      throw new ScriptExitError(0, '', true);
    }

    console.log(chalk.bold.cyan('\n📦 [KYBERION] Interactive Skill Installer\n'));

    if (!targetBundleId) {
      console.log(chalk.white('Available Skill Bundles:'));
      registry.bundles.forEach((bundle) => {
        const statusColor = bundle.status === 'active' ? chalk.green : chalk.yellow;
        console.log(
          `  - ${chalk.bold(bundle.bundle_id)} [${statusColor(bundle.status)}] - ${bundle.summary}`
        );
      });

      targetBundleId = await question(rl, chalk.bold.blue('\nEnter a Bundle ID to install: '));
    }

    const bundle = registry.bundles.find((b) => b.bundle_id === targetBundleId);
    if (!bundle) {
      console.error(chalk.red(`\n❌ Bundle ID '${targetBundleId}' not found in registry.`));
      throw new ScriptExitError(1, '', true);
    }

    console.log(
      chalk.white(
        `\nAnalyzing requirements for skill bundle: ${chalk.bold.magenta(bundle.bundle_id)}...`
      )
    );

    // Run dynamic capability scan
    const allCapabilities = scanProviderCapabilities(undefined, undefined, {
      includeUnavailable: true,
    });
    const requiredRefs = bundle.harness_capability_refs || [];

    const neededCapabilities = allCapabilities.filter((c) =>
      requiredRefs.includes(c.capability_id)
    );
    const missingCapabilities = neededCapabilities.filter((c) => c.discovery_status === 'missing');

    if (neededCapabilities.length === 0) {
      console.log(chalk.green('\n✓ No external runtime capabilities required. Skill is ready!'));
      return;
    }

    console.log(chalk.white('\nRequired Capabilities Status:'));
    neededCapabilities.forEach((c) => {
      const statusIcon =
        c.discovery_status === 'available' ? chalk.green('✅ Available') : chalk.red('❌ Missing');
      console.log(`  - ${c.capability_id} [${statusIcon}] (${c.source.provider})`);
    });

    if (missingCapabilities.length === 0) {
      console.log(
        chalk.bold.green(
          '\n🎉 All required capabilities are already satisfied. Skill is fully active!'
        )
      );
      return;
    }

    console.log(
      chalk.yellow(`\n⚠️  ${missingCapabilities.length} missing capability/dependencies detected.`)
    );

    for (const cap of missingCapabilities) {
      console.log(
        chalk.white(`\nResolving dependency for: ${chalk.bold.yellow(cap.capability_id)}`)
      );

      const mapped = findSkillInstallPackageMapEntry(`${cap.capability_id} ${cap.source.provider}`);
      const installType = mapped?.install_type || null;
      const packageName = mapped?.package_name || '';

      if (installType && packageName) {
        const ans = await question(
          rl,
          chalk.bold.blue(
            `Would you like Kyberion to install '${packageName}' via ${installType}? [Y/n]: `
          )
        );
        if (ans.toLowerCase() !== 'n') {
          const success = await installPackage(installType, packageName);
          if (success) {
            cap.discovery_status = 'available';
          }
        }
      } else {
        console.log(
          chalk.red(
            `Could not deduce auto-installer for ${cap.capability_id}. Please install it manually.`
          )
        );
      }
    }

    // Final verification check
    console.log(chalk.white('\nVerifying post-installation state...'));
    const finalCapabilities = scanProviderCapabilities();
    const finalMissing = finalCapabilities.filter(
      (c) => requiredRefs.includes(c.capability_id) && c.discovery_status === 'missing'
    );

    if (finalMissing.length === 0) {
      console.log(
        chalk.bold.green(
          `\n🎉 Success! All dependencies resolved. Skill '${bundle.bundle_id}' is now fully ACTIVE!`
        )
      );
    } else {
      console.log(
        chalk.yellow(`\n⚠️  Installation finished, but some capabilities remain unresolved.`)
      );
    }
  } finally {
    rl.close();
  }
}

export const runSkillInstaller = defineScript({
  name: 'skill:install',
  flags: [],
  run: ({ argv }) => runInstaller(argv),
});

if (
  isDirectScript(import.meta.url, 'skill_installer.ts') ||
  isDirectScript(import.meta.url, 'skill_installer.js')
)
  void runSkillInstaller();
