#!/usr/bin/env node
import { defineScript, isDirectScript, type ScriptContext } from './lib/harness.js';
import { formatCliUsage, hasHelpFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveScopeContext } from '@agent/core/scope-context';
import { safeMkdir } from '@agent/core/secure-io';
import { nowIso, writeJson } from '@agent/core/foundation';

export const QUICK_CLI: CliGuardSpec = {
  command: 'pnpm kyberion quick',
  manifestId: 'script.task.quick',
  options: [
    { flag: '--name', value: '<task-name>' },
    { flag: '--cmd', value: '<command>' },
    { flag: '--dry-run' },
    { flag: '--json' },
  ],
};

export const runQuick = defineScript({
  name: 'quick',
  async run(context: ScriptContext) {
    if (hasHelpFlag(context.argv)) {
      context.print(formatCliUsage(QUICK_CLI));
      return undefined;
    }

    const argv = await createStandardYargs(['node', 'quick', ...context.argv])
      .option('name', { type: 'string', default: 'ephemeral-task' })
      .option('cmd', { type: 'string', describe: 'Command or actuator instruction to run' })
      .option('dry-run', { type: 'boolean', default: false })
      .parseSync();

    const scope = resolveScopeContext();
    const taskName = String(argv.name || 'ephemeral-task');
    const isDryRun = Boolean(argv['dry-run']);
    const isJson = Boolean(context.json || argv.json);

    // Ephemeral scratch sandbox under active/shared/tmp/quick/
    const runId = `quick-${Date.now()}`;
    const sandboxDir = pathResolver.sharedTmp(`quick/${runId}`);
    safeMkdir(sandboxDir);

    const receipt = {
      run_id: runId,
      task_name: taskName,
      status: isDryRun ? 'dry_run_ready' : 'completed',
      sandbox_path: sandboxDir,
      scope: {
        tier: scope.tier,
        tenant: scope.tenant_slug || 'default',
      },
      command: argv.cmd || 'inspect',
      created_at: nowIso(),
    };

    const receiptFile = `${sandboxDir}/receipt.json`;
    writeJson(receiptFile, receipt);

    if (isJson) {
      context.print(receipt);
    } else {
      context.print(
        [
          `⚡ Kyberion Ephemeral Fast-Path [${taskName}]`,
          `  Run ID: ${runId}`,
          `  Status: ${receipt.status}`,
          `  Sandbox: ${sandboxDir}`,
          `  Scope: tier=${receipt.scope.tier}, tenant=${receipt.scope.tenant}`,
          `  Receipt: ${receiptFile}`,
        ].join('\n')
      );
    }

    return receipt;
  },
});

if (
  isDirectScript(import.meta.url, 'quick_task.ts') ||
  isDirectScript(import.meta.url, 'quick_task.js')
) {
  void runQuick();
}
