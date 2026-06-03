/**
 * reconcile_config_fallbacks.ts
 *
 * Reads the config fallback registry and applies repairs:
 * - file_not_found → writes defaults_snapshot as a new knowledge JSON file
 * - parse_error    → writes a proposals file for human review + reasoning
 *
 * Designed to be called by pipelines/reconcile-config-fallbacks.json.
 * Outputs a structured JSON summary to stdout for pipeline consumption.
 */

import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { listFallbacks, markResolved, pruneResolved, type ConfigFallbackEntry } from '@agent/core/config-fallback-registry';
import * as path from 'node:path';

interface ReconcileResult {
  repaired: { knowledge_path: string; action: string }[];
  proposals_written: { knowledge_path: string; proposal_path: string }[];
  skipped: { knowledge_path: string; reason: string }[];
  pruned: number;
}

function run(): void {
  const entries = listFallbacks().filter(e => !e.resolved);

  const result: ReconcileResult = {
    repaired: [],
    proposals_written: [],
    skipped: [],
    pruned: 0,
  };

  const repairedPaths: string[] = [];

  for (const entry of entries) {
    if (entry.reason === 'file_not_found') {
      handleFileMissing(entry, result, repairedPaths);
    } else if (entry.reason === 'parse_error') {
      handleParseError(entry, result);
    } else {
      result.skipped.push({ knowledge_path: entry.knowledge_path, reason: `unknown failure reason: ${entry.reason}` });
    }
  }

  if (repairedPaths.length > 0) {
    markResolved(repairedPaths);
    result.pruned = pruneResolved();
  }

  process.stdout.write(JSON.stringify(result, null, 2));
}

function handleFileMissing(
  entry: ConfigFallbackEntry,
  result: ReconcileResult,
  repairedPaths: string[],
): void {
  const absPath = pathResolver.knowledge(entry.knowledge_path);
  if (safeExistsSync(absPath)) {
    result.skipped.push({
      knowledge_path: entry.knowledge_path,
      reason: 'file now exists — stale registry entry',
    });
    repairedPaths.push(entry.knowledge_path);
    return;
  }

  // Only auto-create files in public/ tier
  if (!entry.knowledge_path.startsWith('public/')) {
    result.skipped.push({
      knowledge_path: entry.knowledge_path,
      reason: 'not in public/ tier — auto-create skipped for safety',
    });
    return;
  }

  try {
    const dir = path.dirname(absPath);
    safeMkdir(dir);
    const content = JSON.stringify(entry.defaults_snapshot, null, 2);
    safeWriteFile(absPath, content);
    result.repaired.push({ knowledge_path: entry.knowledge_path, action: 'created from defaults_snapshot' });
    repairedPaths.push(entry.knowledge_path);
  } catch (err) {
    result.skipped.push({
      knowledge_path: entry.knowledge_path,
      reason: `write failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    });
  }
}

function handleParseError(entry: ConfigFallbackEntry, result: ReconcileResult): void {
  const proposalsDir = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp', 'config-fallback-proposals');
  try {
    safeMkdir(proposalsDir);
    const slug = entry.knowledge_path.replace(/[^a-zA-Z0-9_-]/g, '_');
    const proposalPath = path.join(proposalsDir, `${slug}.proposal.json`);
    const proposal = {
      knowledge_path: entry.knowledge_path,
      last_error: entry.last_error,
      occurrence_count: entry.occurrence_count,
      first_seen: entry.first_seen,
      last_seen: entry.last_seen,
      defaults_snapshot: entry.defaults_snapshot,
      _instructions: [
        'Review defaults_snapshot below.',
        'If it looks correct, copy it to the knowledge_path to resolve this entry.',
        'If it needs adjustment, edit then write to the knowledge_path.',
        'Re-run the reconcile pipeline after applying to clear this entry.',
      ],
    };
    safeWriteFile(proposalPath, JSON.stringify(proposal, null, 2));
    result.proposals_written.push({
      knowledge_path: entry.knowledge_path,
      proposal_path: path.relative(pathResolver.rootDir(), proposalPath),
    });
  } catch (err) {
    result.skipped.push({
      knowledge_path: entry.knowledge_path,
      reason: `proposal write failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    });
  }
}

run();
