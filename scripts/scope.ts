#!/usr/bin/env node
import { clearScopeEnv, resolveScopeResolution, writeScopeEnv } from '@agent/core';
import type { ScopeContextInput } from '@agent/core';

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

function usage(): never {
  console.error(
    'Usage: pnpm scope show [--json] | pnpm scope use --tier <tier> [--tenant <slug>] [--organization <id>] [--project <id>] [--mission <id>] [--task <id>] | pnpm scope clear'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0] || 'show';
try {
  if (command === 'clear') {
    clearScopeEnv();
    console.log('Cleared persisted scope.');
  } else if (command === 'use') {
    const resolution = resolveScopeResolution(inputFromArgs(args.slice(1)));
    const errors =
      resolution.scope.tier === 'confidential' && !resolution.scope.tenant_slug
        ? ['tenant_slug is required for a confidential scope']
        : [];
    if (errors.length) throw new Error(`[SCOPE_CONTEXT_INVALID] ${errors.join('; ')}`);
    const filePath = writeScopeEnv(resolution.scope);
    console.log(JSON.stringify({ ...resolution, persisted_path: filePath }, null, 2));
  } else if (command === 'show') {
    const resolution = resolveScopeResolution();
    if (args.includes('--json')) console.log(JSON.stringify(resolution, null, 2));
    else {
      console.log(`tier=${resolution.scope.tier}`);
      console.log(`tenant=${resolution.scope.tenant_slug || '(shared)'}`);
      console.log(`organization=${resolution.scope.organization_id || '(none)'}`);
      console.log(`project=${resolution.scope.project_id || '(none)'}`);
      console.log(`roots=${resolution.knowledge_roots.join(',')}`);
      console.log(`provenance=${JSON.stringify(resolution.provenance)}`);
    }
  } else usage();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
