#!/usr/bin/env node
import { clearScopeEnv, resolveScopeResolution, writeScopeEnv } from '@agent/core';
import type { ScopeContextInput } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function inputFromArgs(args: string[]): ScopeContextInput {
  const tier = value(args, '--tier');
  return {
    ...(tier ? { tier: tier as ScopeContextInput['tier'] } : {}),
    ...(value(args, '--tenant') ? { tenant_slug: value(args, '--tenant') } : {}),
    ...(value(args, '--organization') ? { organization_id: value(args, '--organization') } : {}),
    ...(value(args, '--project') ? { project_id: value(args, '--project') } : {}),
    ...(value(args, '--mission') ? { mission_id: value(args, '--mission') } : {}),
    ...(value(args, '--task') ? { task_id: value(args, '--task') } : {}),
  };
}

export const main = defineScript({
  name: 'scope',
  flags: ['json'],
  run(context) {
    const args = context.positional;
    const command = args[0] || 'show';
    if (command === 'clear') {
      clearScopeEnv();
      context.print('Cleared persisted scope.');
      return;
    }
    if (command === 'use') {
      const resolution = resolveScopeResolution(inputFromArgs(args.slice(1)));
      if (resolution.scope.tier === 'confidential' && !resolution.scope.tenant_slug) {
        throw new Error('[SCOPE_CONTEXT_INVALID] tenant_slug is required for a confidential scope');
      }
      const filePath = writeScopeEnv(resolution.scope);
      context.print({ ...resolution, persisted_path: filePath });
      return;
    }
    if (command === 'show') {
      const resolution = resolveScopeResolution();
      if (context.json) {
        context.print(resolution);
      } else {
        context.print(`tier=${resolution.scope.tier}`);
        context.print(`tenant=${resolution.scope.tenant_slug || '(shared)'}`);
        context.print(`organization=${resolution.scope.organization_id || '(none)'}`);
        context.print(`project=${resolution.scope.project_id || '(none)'}`);
        context.print(`roots=${resolution.knowledge_roots.join(',')}`);
        context.print(`provenance=${JSON.stringify(resolution.provenance)}`);
      }
      return;
    }
    throw new Error(
      'Usage: pnpm scope show [--json] | pnpm scope use --tier <tier> [--tenant <slug>] [--organization <id>] [--project <id>] [--mission <id>] [--task <id>] | pnpm scope clear'
    );
  },
});

if (isDirectScript(import.meta.url, 'scope.ts') || isDirectScript(import.meta.url, 'scope.js')) {
  void main();
}
