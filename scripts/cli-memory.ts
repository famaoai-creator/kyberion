#!/usr/bin/env node
import { handleAction } from '../libs/actuators/working-memory-actuator/src/index.js';
import { defineScript, isDirectScript } from './lib/harness.js';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export const runMemoryCommand = defineScript({
  name: 'memory',
  flags: ['json'],
  async run(context) {
    const args = context.positional;
    const subcommand = args[0] || 'help';
    const json = args.includes('--json');
    if (subcommand === 'help' || args.includes('--help') || args.includes('-h')) {
      context.print(
        'Usage: kyberion memory capture --content <text> [--section <name>] [--json]\n' +
          '       kyberion memory read --path <active-path> [--json]\n' +
          '       kyberion memory list [--scope <scope>] [--status <status>] [--json]\n' +
          '       kyberion memory promote --path <active-path> --summary <text> [--json]'
      );
      return;
    }

    let result: unknown;
    if (subcommand === 'capture') {
      const content = flag(args, '--content');
      if (!content?.trim()) throw new Error('memory capture requires --content <text>');
      result = await handleAction({
        action: 'working-memory:note',
        params: {
          content,
          scope: flag(args, '--scope') || 'personal',
          ...(flag(args, '--scope-ref') ? { scope_ref: flag(args, '--scope-ref') } : {}),
          tier: flag(args, '--tier') || 'personal',
          ...(flag(args, '--section') ? { section: flag(args, '--section') } : {}),
          ...(args.includes('--trusted') ? { trusted: true } : {}),
        },
      });
    } else if (subcommand === 'read') {
      const mdPath = flag(args, '--path');
      if (!mdPath) throw new Error('memory read requires --path <active-path>');
      result = await handleAction({ action: 'working-memory:read', params: { mdPath } });
    } else if (subcommand === 'list') {
      result = await handleAction({
        action: 'working-memory:list',
        params: {
          ...(flag(args, '--scope') ? { scope: flag(args, '--scope') } : {}),
          ...(flag(args, '--status') ? { status: flag(args, '--status') } : {}),
        },
      });
    } else if (subcommand === 'promote') {
      const mdPath = flag(args, '--path');
      const summary = flag(args, '--summary');
      if (!mdPath || !summary) {
        throw new Error('memory promote requires --path <active-path> and --summary <text>');
      }
      result = await handleAction({
        action: 'working-memory:nominate-promotion',
        params: {
          mdPath,
          summary,
          ...(flag(args, '--sensitivity-tier')
            ? { sensitivity_tier: flag(args, '--sensitivity-tier') }
            : {}),
          ...(flag(args, '--source-ref') ? { source_ref: flag(args, '--source-ref') } : {}),
        },
      });
    } else {
      throw new Error(`Unknown memory subcommand: ${subcommand}`);
    }
    context.print(json ? result : JSON.stringify(result, null, 2));
  },
});

if (
  isDirectScript(import.meta.url, 'cli-memory.ts') ||
  isDirectScript(import.meta.url, 'cli-memory.js')
) {
  void runMemoryCommand();
}
