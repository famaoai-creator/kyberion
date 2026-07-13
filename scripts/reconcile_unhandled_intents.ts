/**
 * reconcile_unhandled_intents.ts
 *
 * Reads the unhandled-intent registry and writes proposal stubs:
 *   - 'unrouted'     → suggest an entry for intent-routing-map.json
 *   - 'unrecognized' → suggest a new intent definition for standard-intents.json
 *                      or keywords to add to an existing intent
 *
 * The pipeline then passes proposals to reasoning:analyze for suggestions.
 * Outputs a structured JSON summary to stdout for pipeline consumption.
 */

import { slugify } from '@agent/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import {
  listUnhandledIntents,
  type UnhandledIntentEntry,
} from '@agent/core/unhandled-intent-registry';
import * as path from 'node:path';

interface ReconcileResult {
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

const PROPOSALS_RELATIVE = path.join('active', 'shared', 'tmp', 'unhandled-intent-proposals');
const SUMMARY_RELATIVE = path.join(
  'active',
  'shared',
  'tmp',
  'unhandled-intent-last-run.summary.txt'
);

function run(): void {
  const entries = listUnhandledIntents().filter((e) => !e.reconciled);
  const top =
    entries.slice().sort((a, b) => {
      const countDiff = (b.occurrence_count || 0) - (a.occurrence_count || 0);
      if (countDiff !== 0) return countDiff;
      return String(a.last_seen || '').localeCompare(String(b.last_seen || ''));
    })[0] || null;
  const result: ReconcileResult = {
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

  const absProposalsDir = path.join(pathResolver.rootDir(), PROPOSALS_RELATIVE);

  for (const entry of entries) {
    writeProposal(entry, absProposalsDir, result);
  }

  safeWriteFile(path.join(pathResolver.rootDir(), SUMMARY_RELATIVE), `${result.summary_line}\n`);
  process.stdout.write(JSON.stringify(result, null, 2));
}

function writeProposal(
  entry: UnhandledIntentEntry,
  proposalsDir: string,
  result: ReconcileResult
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

run();
