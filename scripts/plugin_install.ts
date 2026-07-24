/**
 * KD-06 wiring: operator CLI for `installPluginManaged`.
 *
 * Stages a plugin source into the managed-copy directory, prints the
 * provenance-derived trust label, and — for anything other than `official`
 * — the pending approval id and how to approve it via the existing
 * approval CLI (`pnpm cli -- approvals` / `pnpm cli -- approve <id>
 * <channel>`). Installing (staging + listing) never itself requires
 * approval; only activation does (enforced at load time by
 * `skill-plugin-loader.ts`, not by this script).
 *
 * No interactive prompts — every input is a flag.
 *
 * Usage:
 *   pnpm plugin:install --source ./some/plugin --id my-plugin
 *   pnpm plugin:install --source ./some/plugin --id my-plugin --requested-by alice
 */
import { createStandardYargs, installPluginManaged, logger } from '@agent/core';

export function runPluginInstall(): number {
  const argv = createStandardYargs()
    .scriptName('plugin_install')
    .option('source', {
      type: 'string',
      describe: 'Filesystem path to the already-fetched plugin content to stage',
    })
    .option('id', { type: 'string', describe: 'Plugin id for the managed slot' })
    .option('requested-by', {
      type: 'string',
      describe: 'Identity to record as the requester on any resulting approval request',
    })
    .option('channel', {
      type: 'string',
      describe:
        'Approval storage channel to use for a non-official plugin (defaults to plugin-install)',
    })
    .option('managed-root', {
      type: 'string',
      describe: 'Override the managed-plugins root (defaults to active/shared/plugins/managed)',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const source = argv.source ? String(argv.source) : '';
  const pluginId = argv.id ? String(argv.id) : '';
  if (!source || !pluginId) {
    logger.error('Usage: pnpm plugin:install --source <path> --id <plugin-id>');
    return 1;
  }

  const record = installPluginManaged({
    pluginId,
    sourcePath: source,
    ...(argv['requested-by'] ? { requestedBy: String(argv['requested-by']) } : {}),
    ...(argv.channel ? { approvalChannel: String(argv.channel) } : {}),
    ...(argv['managed-root'] ? { managedRoot: String(argv['managed-root']) } : {}),
  });

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record.activationStatus === 'blocked_broken_manifest' ? 1 : 0;
  }

  process.stdout.write(`Plugin '${record.pluginId}' staged at: ${record.managedPath}\n`);
  process.stdout.write(`Trust: ${record.trust} (${record.trustReason})\n`);
  process.stdout.write(`Activation status: ${record.activationStatus}\n`);

  if (record.diagnostics.length > 0) {
    process.stdout.write('Diagnostics:\n');
    for (const diagnostic of record.diagnostics) {
      process.stdout.write(
        `  [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`
      );
    }
  }

  if (record.activationStatus === 'blocked_broken_manifest') {
    process.stdout.write(
      'This plugin will never be loaded — fix the manifest and re-run plugin:install.\n'
    );
    return 1;
  }

  if (record.trust !== 'official' && record.approvalRequestId) {
    process.stdout.write(
      [
        '',
        `This is a non-official (${record.trust}) source, so it stays pending until a human approves it:`,
        `  Approval request id: ${record.approvalRequestId}`,
        `  Storage channel:      ${record.approvalChannel}`,
        '',
        'To review and decide:',
        `  pnpm cli -- approvals`,
        `  pnpm cli -- approve ${record.approvalRequestId} ${record.approvalChannel}`,
        '',
        'The plugin is skipped (never executed) at skill-load time until then.',
      ].join('\n') + '\n'
    );
  } else {
    process.stdout.write(
      'This plugin is activatable and will be loaded when configured in .kyberion-plugins.json.\n'
    );
  }

  return 0;
}

const isDirect = process.argv[1] && /plugin_install\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  try {
    process.exit(runPluginInstall());
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
