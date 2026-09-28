/**
 * Kyberion Vault Mount CLI
 *
 * Implements Vector 4 of The Data Ingestion Protocol.
 * Mounts external host directories or files into vault/mounts/ via governed symlinks.
 *
 * Usage:
 *   pnpm kyberion vault mount <source-path> [name]
 *   pnpm kyberion vault unmount <name>
 *   pnpm kyberion vault list
 */

import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  listVaultMounts,
  mountToVault,
  unmountFromVault,
  cleanupVaultMounts,
  getVaultMountsDir,
} from '@agent/core/secret/vault-mount';

export async function main(argv: string[], print: (msg: string) => void): Promise<void> {
  const normalizedArgs = argv.filter((arg) => arg !== '--');
  const parser = createStandardYargs(['node', 'vault_mount_cli', ...normalizedArgs])
    .command('mount <source> [name]', 'Mount an external host path into vault/mounts/')
    .command('unmount <name>', 'Unmount (remove) a mount from vault/mounts/')
    .command('cleanup', 'Remove broken symlinks in vault/mounts/')
    .command('list', 'List active vault mounts')
    .option('json', {
      type: 'boolean',
      description: 'Output results as JSON',
      default: false,
    })
    .help();

  const parsed = await parser.parse();
  const subCommand = parsed._[0] as string | undefined;

  if (subCommand === 'cleanup') {
    const removed = cleanupVaultMounts();
    if (parsed.json) {
      print(JSON.stringify({ removed }, null, 2));
    } else {
      if (removed.length === 0) {
        print('[vault-mount] No broken mounts found. Everything is healthy.');
      } else {
        print(`[vault-mount] Cleaned up ${removed.length} broken mount(s): ${removed.join(', ')}`);
      }
    }
    return;
  }

  if (subCommand === 'mount') {
    const source = (parsed.source as string) || (parsed._[1] as string);
    const name = (parsed.name as string) || (parsed._[2] as string | undefined);
    if (!source) {
      throw new ScriptExitError(
        1,
        'Missing source path. Usage: pnpm kyberion vault mount <path> [name]'
      );
    }

    try {
      const entry = mountToVault(source, name);
      if (parsed.json) {
        print(JSON.stringify(entry, null, 2));
      } else {
        print(`[vault-mount] Successfully mounted:`);
        print(`  Name:   ${entry.name}`);
        print(`  Mount:  ${entry.mountPath}`);
        print(`  Target: ${entry.targetPath} (${entry.isDir ? 'directory' : 'file'})`);
        print(`\nAI agents can now access this via vault/mounts/${entry.name} in read-only mode.`);
      }
    } catch (err: any) {
      throw new ScriptExitError(1, `Failed to mount: ${err.message}`);
    }
    return;
  }

  if (subCommand === 'unmount') {
    const name = (parsed.name as string) || (parsed._[1] as string);
    if (!name) {
      throw new ScriptExitError(1, 'Missing mount name. Usage: pnpm kyberion vault unmount <name>');
    }

    const removed = unmountFromVault(name);
    if (removed) {
      print(`[vault-mount] Successfully unmounted: ${name}`);
    } else {
      throw new ScriptExitError(1, `No active mount found with name: ${name}`);
    }
    return;
  }

  // Default: list mounts
  const mounts = listVaultMounts();
  if (parsed.json) {
    print(JSON.stringify(mounts, null, 2));
  } else {
    print(
      `[vault-mount] Active Vault Mounts (${mounts.length} total, location: ${getVaultMountsDir()}):\n`
    );
    if (mounts.length === 0) {
      print(
        '  (No external paths currently mounted. Use `pnpm kyberion vault mount <path>` to connect)'
      );
    } else {
      const headers = ['Name', 'Type', 'Status', 'Target Path'];
      const rows = mounts.map((m) => [
        m.name,
        m.isDir ? 'DIR' : 'FILE',
        m.status.toUpperCase(),
        m.targetPath,
      ]);
      const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      const formatRow = (cols: string[]) => cols.map((c, i) => c.padEnd(colWidths[i])).join('  ');
      print(formatRow(headers));
      print(colWidths.map((w) => '-'.repeat(w)).join('  '));
      rows.forEach((r) => print(formatRow(r)));
    }
  }
}

export const vaultMountCli = defineScript({
  name: 'vault-mount-cli',
  flags: ['json', 'quiet'],
  async run(context) {
    await main(context.argv, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'vault_mount_cli.ts') ||
  isDirectScript(import.meta.url, 'vault_mount_cli.js')
) {
  void vaultMountCli();
}
