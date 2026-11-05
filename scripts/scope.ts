#!/usr/bin/env node
import {
  clearScopeEnv,
  popScopeEnv,
  pushScopeEnv,
  resolveScopeResolution,
  writeScopeEnv,
} from '@agent/core/scope-context';
import type { ScopeContextInput } from '@agent/core/scope-context';
import { inspectAssetScopeRead } from '@agent/core/governance/asset-scope-inspection';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import type { ScriptContext } from './lib/harness.js';

/** Diagnose current read policy and asset attribution without changing scope. */
function runScopeInspectCli(context: Pick<ScriptContext, 'argv' | 'json' | 'print'>): void {
  const args = context.argv.filter((arg) => arg !== '--json');
  if (
    args.length !== 2 ||
    args[0] !== 'inspect' ||
    !args[1]?.trim() ||
    args[1].startsWith('-') ||
    context.argv.filter((arg) => arg === '--json').length > 1
  ) {
    throw new ScriptExitError(2, 'Usage: pnpm scope inspect <path> [--json]');
  }
  // Selection flags are never translated into a trusted read ceiling.
  const inspection = inspectAssetScopeRead(args[1]);
  if (context.json) {
    context.print({
      ...inspection,
      limits: {
        decision: 'read_policy_only',
        existence: 'undetermined',
        full_io_admission: 'not_evaluated',
        target_content: 'not_returned',
        ceiling_comparison: 'not_requested',
      },
    });
    return;
  }
  context.print(`read policy=${inspection.decision.allowed ? 'allowed' : 'denied'}`);
  context.print(`reason=${inspection.decision.reason ?? '(unspecified)'}`);
  const shadow = inspection.shadow;
  if ('resolution' in shadow && shadow.resolution.status === 'resolved') {
    const address = shadow.resolution.address;
    context.print(`store=${address.store}`);
    context.print(`location=${address.location}`);
    context.print(`custody=${address.custody.kind}:${address.custody.ref}`);
    context.print(`tier=${address.tier}`);
  } else if ('resolution' in shadow && shadow.resolution.status === 'unresolved') {
    context.print(`asset=unresolved (${shadow.resolution.reason})`);
  } else {
    context.print('asset=unavailable');
  }
  context.print('trusted ceiling comparison=not requested');
  context.print(
    'existence=undetermined; full IO admission=not evaluated; no target content output'
  );
}

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
    if (command === 'inspect') {
      runScopeInspectCli(context);
      return;
    }
    if (command === 'operator') {
      writeScopeEnv({ tier: 'personal' });
      context.print(
        'Persisted personal operator scope. Shell environment overrides still apply; confirm with pnpm scope show.'
      );
      return;
    }
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
    if (command === 'push') {
      const { depth } = pushScopeEnv();
      context.print(`Stashed current scope (depth=${depth}). Restore with \`pnpm scope pop\`.`);
      return;
    }
    if (command === 'pop') {
      const { depth } = popScopeEnv();
      const resolution = resolveScopeResolution();
      context.print({ ...resolution, restored: true, depth });
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
      'Usage: pnpm scope show [--json] | pnpm scope inspect <path> [--json] | pnpm scope operator | pnpm scope use --tier <tier> [--tenant <slug>] [--organization <id>] [--project <id>] [--mission <id>] [--task <id>] | pnpm scope push | pnpm scope pop | pnpm scope clear'
    );
  },
});

if (isDirectScript(import.meta.url, 'scope.ts') || isDirectScript(import.meta.url, 'scope.js')) {
  void main();
}
