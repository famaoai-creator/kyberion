/**
 * reconcile_unclassified_errors.ts
 *
 * Reads the unclassified-error registry and writes rule-proposal stubs for each
 * unreconciled entry. The pipeline then passes these to reasoning:analyze for
 * category / pattern suggestions. Human reviews and appends accepted rules to
 * knowledge/product/governance/error-classifier-rules.json.
 *
 * Outputs a structured JSON summary to stdout for pipeline consumption.
 */

import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import {
  listUnclassifiedErrors,
  type UnclassifiedErrorEntry,
} from '@agent/core/unclassified-error-registry';
import * as path from 'node:path';

interface ReconcileResult {
  proposals_written: { message_excerpt: string; proposal_path: string }[];
  skipped: { message_excerpt: string; reason: string }[];
  total_unreconciled: number;
}

const PROPOSALS_RELATIVE = path.join('active', 'shared', 'tmp', 'unclassified-error-proposals');

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60).replace(/^_|_$/g, '');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(): void {
  const entries = listUnclassifiedErrors().filter(e => !e.reconciled);
  const result: ReconcileResult = {
    proposals_written: [],
    skipped: [],
    total_unreconciled: entries.length,
  };

  const absProposalsDir = path.join(pathResolver.rootDir(), PROPOSALS_RELATIVE);

  for (const entry of entries) {
    writeProposal(entry, absProposalsDir, result);
  }

  process.stdout.write(JSON.stringify(result, null, 2));
}

function writeProposal(
  entry: UnclassifiedErrorEntry,
  proposalsDir: string,
  result: ReconcileResult,
): void {
  try {
    safeMkdir(proposalsDir);
    const slug = slugify(entry.message_excerpt) || 'unknown_error';
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

run();
