/**
 * scripts/dot_charters.ts — list resident-agent ('dot') charters.
 *
 * Usage:
 *   pnpm kyberion dot list             # human-readable table (active dots)
 *   pnpm kyberion dot list --json      # machine-readable
 *   pnpm kyberion dot list --all       # include draft/paused/retired
 *   pnpm kyberion dot list --status=paused
 *
 * Charters are the declarative contract for resident agents; see dots/README.md
 * and knowledge/product/architecture/resident-dot-model.md.
 */

import {
  listDotCharterPaths,
  loadDotCharter,
  type DotCharterStatus,
} from '@agent/core/dot/dot-charter';
import { defineScript, isDirectScript } from './lib/harness.js';

const STATUSES: DotCharterStatus[] = ['draft', 'active', 'paused', 'retired'];

async function main(argv: string[]): Promise<Record<string, unknown>> {
  const wantAll = argv.includes('--all');
  const statusArg = argv.find((arg) => arg.startsWith('--status='))?.split('=')[1];
  if (statusArg && !STATUSES.includes(statusArg as DotCharterStatus)) {
    throw new Error(`--status must be one of: ${STATUSES.join(', ')}`);
  }
  const wanted: DotCharterStatus | undefined = wantAll
    ? undefined
    : ((statusArg as DotCharterStatus | undefined) ?? 'active');

  const dots: Array<Record<string, unknown>> = [];
  const errors: Array<{ path: string; error: string }> = [];
  // One malformed charter must not hide the rest — report and continue.
  for (const filePath of listDotCharterPaths()) {
    try {
      const charter = loadDotCharter(filePath);
      if (wanted && charter.status !== wanted) continue;
      dots.push({
        dot_id: charter.dot_id,
        status: charter.status,
        title: charter.title,
        authority_role: charter.authority.authority_role,
        heartbeat_id: charter.runtime.heartbeat_id,
        triggers: charter.attention.triggers.map((trigger) => trigger.kind),
        path: filePath,
      });
    } catch (error) {
      errors.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    count: dots.length,
    dots,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export const runDotCharters = defineScript({
  name: 'dot-charters',
  flags: ['json'],
  async run(context) {
    const report = await main(context.argv);
    if (context.json) {
      context.print(report);
      return report;
    }
    for (const dot of report.dots as Array<Record<string, unknown>>) {
      context.print(
        `${dot.status}  ${String(dot.dot_id).padEnd(24)} ${dot.title}  [${dot.authority_role}]  triggers=${(dot.triggers as string[]).join(',')}  heartbeat=${dot.heartbeat_id}`
      );
    }
    for (const error of (report.errors ?? []) as Array<{ path: string; error: string }>) {
      context.print(`invalid  ${error.path}: ${error.error}`);
    }
    context.print(`-- ${report.count} dot(s)`);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'dot_charters.ts') ||
  isDirectScript(import.meta.url, 'dot_charters.js')
) {
  void runDotCharters();
}
