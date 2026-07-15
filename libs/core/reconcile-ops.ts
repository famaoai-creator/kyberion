/**
 * LE-03: reconcile registry sweeps as callable library functions.
 *
 * These used to live inline in scripts/reconcile_*.ts and were reachable only
 * through `system:shell` wrapper steps (`node dist/scripts/...`), which hid
 * the logic from trace spans and let non-zero output vanish behind
 * `2>/dev/null || echo '{}'` fallbacks. The scripts are now thin CLI shells
 * and the system-actuator exposes each sweep as an in-process capture op
 * (`system:reconcile_*`) whose structured result lands directly in pipeline ctx.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile, safeExistsSync, safeMkdir } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import {
  listFallbacks,
  markResolved,
  pruneResolved,
  type ConfigFallbackEntry,
} from './config-fallback-registry.js';
import {
  listUnclassifiedErrors,
  type UnclassifiedErrorEntry,
} from './unclassified-error-registry.js';
import { listUnhandledIntents, type UnhandledIntentEntry } from './unhandled-intent-registry.js';
import { slugify } from './text-utils.js';

// ─── config fallbacks ───────────────────────────────────────

export interface ConfigFallbackReconcileResult {
  repaired: { knowledge_path: string; action: string }[];
  proposals_written: { knowledge_path: string; proposal_path: string }[];
  skipped: { knowledge_path: string; reason: string }[];
  pruned: number;
}

export function reconcileConfigFallbacks(): ConfigFallbackReconcileResult {
  const entries = listFallbacks().filter((e) => !e.resolved);

  const result: ConfigFallbackReconcileResult = {
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
      result.skipped.push({
        knowledge_path: entry.knowledge_path,
        reason: `unknown failure reason: ${entry.reason}`,
      });
    }
  }

  if (repairedPaths.length > 0) {
    markResolved(repairedPaths);
    result.pruned = pruneResolved();
  }

  return result;
}

function handleFileMissing(
  entry: ConfigFallbackEntry,
  result: ConfigFallbackReconcileResult,
  repairedPaths: string[]
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
    // The public-tier auto-create is the only governed knowledge write in this
    // sweep; it runs under its own narrowly-scoped authority role
    // (security-policy.json authority_role_permissions.reconcile_config_fallbacks).
    withExecutionContext('reconcile_config_fallbacks', () => {
      const dir = path.dirname(absPath);
      safeMkdir(dir);
      const content = JSON.stringify(entry.defaults_snapshot, null, 2);
      safeWriteFile(absPath, content);
    });
    result.repaired.push({
      knowledge_path: entry.knowledge_path,
      action: 'created from defaults_snapshot',
    });
    repairedPaths.push(entry.knowledge_path);
  } catch (err) {
    result.skipped.push({
      knowledge_path: entry.knowledge_path,
      reason: `write failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    });
  }
}

function handleParseError(entry: ConfigFallbackEntry, result: ConfigFallbackReconcileResult): void {
  const proposalsDir = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    'config-fallback-proposals'
  );
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

// ─── unclassified errors ────────────────────────────────────

export interface UnclassifiedErrorReconcileResult {
  proposals_written: { message_excerpt: string; proposal_path: string }[];
  skipped: { message_excerpt: string; reason: string }[];
  total_unreconciled: number;
}

const ERROR_PROPOSALS_RELATIVE = path.join(
  'active',
  'shared',
  'tmp',
  'unclassified-error-proposals'
);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function reconcileUnclassifiedErrors(): UnclassifiedErrorReconcileResult {
  const entries = listUnclassifiedErrors().filter((e) => !e.reconciled);
  const result: UnclassifiedErrorReconcileResult = {
    proposals_written: [],
    skipped: [],
    total_unreconciled: entries.length,
  };

  const absProposalsDir = path.join(pathResolver.rootDir(), ERROR_PROPOSALS_RELATIVE);

  for (const entry of entries) {
    writeErrorProposal(entry, absProposalsDir, result);
  }

  return result;
}

function writeErrorProposal(
  entry: UnclassifiedErrorEntry,
  proposalsDir: string,
  result: UnclassifiedErrorReconcileResult
): void {
  try {
    safeMkdir(proposalsDir);
    const slug =
      slugify(entry.message_excerpt, { separator: '_', maxLength: 60 }).replace(/^_|_$/g, '') ||
      'unknown_error';
    const proposalPath = path.join(proposalsDir, `${slug}.proposal.json`);

    // Derive a candidate pattern from the excerpt: escape special chars, use first 60 chars.
    const patternBase = escapeRegex(entry.message_excerpt.slice(0, 60));

    const proposal = {
      message_excerpt: entry.message_excerpt,
      ...(entry.code !== undefined ? { code: entry.code } : {}),
      occurrence_count: entry.occurrence_count,
      first_seen: entry.first_seen,
      last_seen: entry.last_seen,
      suggested_rule: {
        id: `rule_${slug}`,
        category: '',
        label: '',
        remediation: '',
        patterns: [patternBase],
        ...(entry.code !== undefined ? { codes: [entry.code] } : {}),
        repairAction: '',
      },
      _instructions: [
        'Fill in category, label, remediation, and patterns for this unrecognized error.',
        'Valid categories: auth | permission_denied | network | rate_limit | missing_dependency |',
        '  missing_secret | invalid_input | resource_unavailable | timeout | governance_block |',
        '  tier_violation | mission_not_found | unknown',
        'patterns: array of regex strings (case-insensitive) that match this error message.',
        'Once accepted, append suggested_rule to:',
        '  knowledge/product/governance/error-classifier-rules.json  (under "rules" array)',
        'Then call markReconciled([message_excerpt]) to clear this entry from the registry.',
      ],
    };

    safeWriteFile(proposalPath, JSON.stringify(proposal, null, 2));
    result.proposals_written.push({
      message_excerpt: entry.message_excerpt.slice(0, 80),
      proposal_path: path.relative(pathResolver.rootDir(), proposalPath),
    });
  } catch (err) {
    result.skipped.push({
      message_excerpt: entry.message_excerpt.slice(0, 80),
      reason: `proposal write failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    });
  }
}

// ─── unhandled intents ──────────────────────────────────────

export interface UnhandledIntentReconcileResult {
  proposals_written: { miss_type: string; key: string; proposal_path: string }[];
  skipped: { miss_type: string; key: string; reason: string }[];
  total_unreconciled: number;
  top_unreconciled: null | {
    miss_type: string;
    key: string;
    occurrence_count: number;
    utterance_sample: string;
  };
  summary_line: string;
}

const INTENT_PROPOSALS_RELATIVE = path.join(
  'active',
  'shared',
  'tmp',
  'unhandled-intent-proposals'
);
const INTENT_SUMMARY_RELATIVE = path.join(
  'active',
  'shared',
  'tmp',
  'unhandled-intent-last-run.summary.txt'
);

export function reconcileUnhandledIntents(): UnhandledIntentReconcileResult {
  const entries = listUnhandledIntents().filter((e) => !e.reconciled);
  const top =
    entries.slice().sort((a, b) => {
      const countDiff = (b.occurrence_count || 0) - (a.occurrence_count || 0);
      if (countDiff !== 0) return countDiff;
      return String(a.last_seen || '').localeCompare(String(b.last_seen || ''));
    })[0] || null;
  const result: UnhandledIntentReconcileResult = {
    proposals_written: [],
    skipped: [],
    total_unreconciled: entries.length,
    top_unreconciled: top
      ? {
          miss_type: top.miss_type,
          key: top.intent_id ?? top.utterance_samples[0] ?? 'unknown',
          occurrence_count: top.occurrence_count,
          utterance_sample: top.utterance_samples[0] ?? '',
        }
      : null,
    summary_line: top
      ? `[UNHANDLED-INTENT] unreconciled=${entries.length} top=${top.intent_id ?? top.utterance_samples[0] ?? 'unknown'} (${top.occurrence_count})`
      : '[UNHANDLED-INTENT] unreconciled=0 top=none',
  };

  const absProposalsDir = path.join(pathResolver.rootDir(), INTENT_PROPOSALS_RELATIVE);

  for (const entry of entries) {
    writeIntentProposal(entry, absProposalsDir, result);
  }

  safeWriteFile(
    path.join(pathResolver.rootDir(), INTENT_SUMMARY_RELATIVE),
    `${result.summary_line}\n`
  );
  return result;
}

function writeIntentProposal(
  entry: UnhandledIntentEntry,
  proposalsDir: string,
  result: UnhandledIntentReconcileResult
): void {
  const key = entry.intent_id ?? entry.utterance_samples[0] ?? 'unknown';
  try {
    safeMkdir(proposalsDir);
    const slug =
      slugify(key, { separator: '_', maxLength: 60 }).replace(/^_|_$/g, '') || 'unknown_intent';
    const filename = `${entry.miss_type}_${slug}.proposal.json`;
    const proposalPath = path.join(proposalsDir, filename);

    const proposal =
      entry.miss_type === 'unrouted'
        ? buildUnroutedProposal(entry, key)
        : buildUnrecognizedProposal(entry, key);

    safeWriteFile(proposalPath, JSON.stringify(proposal, null, 2));
    result.proposals_written.push({
      miss_type: entry.miss_type,
      key: key.slice(0, 80),
      proposal_path: path.relative(pathResolver.rootDir(), proposalPath),
    });
  } catch (err) {
    result.skipped.push({
      miss_type: entry.miss_type,
      key: key.slice(0, 80),
      reason: `proposal write failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    });
  }
}

function buildUnroutedProposal(entry: UnhandledIntentEntry, key: string): object {
  const suggestedShape = entry.shape ?? 'pipeline';
  return {
    miss_type: 'unrouted',
    intent_id: entry.intent_id,
    shape: entry.shape,
    utterance_samples: entry.utterance_samples,
    occurrence_count: entry.occurrence_count,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    suggested_routing:
      suggestedShape === 'mission'
        ? {
            map: 'mission_intent_action_map',
            entry: { [key]: '' },
            valid_actions: [
              'create',
              'classify',
              'workflow',
              'compose_team',
              'prewarm_team',
              'delegate_task',
              'review_output',
              'handoff',
              'distill',
              'close',
              'inspect_state',
            ],
          }
        : {
            map: 'pipeline_intent_map',
            entry: { [key]: '' },
            note: 'Set value to the pipeline filename without path or .json extension (e.g. "generate-report")',
          },
    _instructions: [
      `intent_id "${entry.intent_id}" was recognized but has no routing entry.`,
      `Shape is "${entry.shape ?? 'unknown'}".`,
      `Add the entry above to knowledge/product/governance/intent-routing-map.json`,
      `under "${suggestedShape === 'mission' ? 'mission_intent_action_map' : 'pipeline_intent_map'}".`,
      'Then call markIntentsReconciled([intent_id]) to clear this entry from the registry.',
    ],
  };
}

function buildUnrecognizedProposal(entry: UnhandledIntentEntry, key: string): object {
  const slug =
    slugify(key, { separator: '_', maxLength: 60 }).replace(/^_|_$/g, '') || 'new_intent';
  return {
    miss_type: 'unrecognized',
    utterance_samples: entry.utterance_samples,
    occurrence_count: entry.occurrence_count,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    suggested_intent: {
      id: slug,
      category: 'surface',
      description: '',
      execution_shape: 'pipeline',
      trigger_keywords: [],
      surface_examples: entry.utterance_samples,
    },
    _instructions: [
      'These utterances scored below the confidence threshold for all known intents.',
      'Option A: Add suggested_intent to knowledge/product/governance/standard-intents.json',
      '  and add a routing entry to intent-routing-map.json.',
      "Option B: If this utterance matches an existing intent, add it to that intent's",
      '  surface_examples or trigger_keywords to improve matching.',
      'Then call markIntentsReconciled([utterance_sample]) to clear this entry.',
    ],
  };
}
