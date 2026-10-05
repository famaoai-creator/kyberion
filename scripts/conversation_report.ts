import {
  listConversationSignals,
  summarizeConversationSignals,
  type ConversationSignalSummary,
} from '@agent/core/intent/conversation-signals';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * How is the operator-facing conversation going?
 *
 *   node dist/scripts/conversation_report.js [--days N] [--json]
 *
 * Reads the conversation signal ledger (libs/core/intent/conversation-signals.ts):
 * turn outcomes per intent, how many clarification questions went unanswered,
 * and the utterances that keep failing. The failing utterances are candidates
 * for the Japanese contextual-intent eval corpus
 * (knowledge/product/governance/japanese-contextual-intent-corpus.json): a
 * person reviews them and adds the ones worth guarding; nothing is added
 * automatically.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 14;
const MIN_CANDIDATE_COUNT = 2;
const MAX_ROWS = 10;

function readDays(argv: string[]): number {
  const index = argv.indexOf('--days');
  if (index < 0) return DEFAULT_DAYS;
  const days = Number(argv[index + 1]);
  if (!Number.isInteger(days) || days < 1) {
    throw new ScriptExitError(
      2,
      `--days requires a positive integer, got: ${argv[index + 1] ?? ''}`
    );
  }
  return days;
}

export function formatConversationReport(summary: ConversationSignalSummary, days: number): string {
  const lines = [`Conversation report — last ${days} day(s), ${summary.total} signal(s)`];
  if (summary.total === 0) {
    lines.push('', 'No conversation signals recorded in this window.');
    return lines.join('\n');
  }
  const kinds = Object.entries(summary.by_kind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`);
  lines.push(`By kind: ${kinds.join(', ')}`);

  const { asked, abandoned, abandon_rate } = summary.clarification;
  if (asked > 0) {
    const rate = abandon_rate === null ? '-' : `${Math.round(abandon_rate * 100)}%`;
    lines.push(`Clarification: ${asked} asked, ${abandoned} unanswered after 24 h (${rate})`);
  }

  const problem = summary.by_intent.filter(
    (intent) =>
      intent.failed + intent.unhandled + intent.dissatisfied + intent.clarification_abandoned > 0
  );
  if (problem.length > 0) {
    lines.push('', 'Intents needing attention:');
    for (const intent of problem.slice(0, MAX_ROWS)) {
      lines.push(
        `  ${intent.intent_id}: ${intent.turns} turn(s), failed ${intent.failed}, unhandled ${intent.unhandled}, dissatisfied ${intent.dissatisfied}, unanswered questions ${intent.clarification_abandoned}`
      );
    }
  }

  const candidates = summary.miss_clusters.filter(
    (cluster) => cluster.count >= MIN_CANDIDATE_COUNT
  );
  if (candidates.length > 0) {
    lines.push('', 'Repeated misses — review for the eval corpus:');
    for (const cluster of candidates.slice(0, MAX_ROWS)) {
      lines.push(
        `  x${cluster.count} [${cluster.kinds.join(', ')}] ${cluster.excerpt ?? `#${cluster.utterance_hash}`}${cluster.intent_id ? ` (${cluster.intent_id})` : ''}`
      );
    }
  }
  return lines.join('\n');
}

export const runConversationReport = defineScript({
  name: 'conversation-report',
  flags: ['json'],
  run(context) {
    const days = readDays(context.argv);
    const signals = listConversationSignals({ sinceMs: Date.now() - days * DAY_MS });
    const summary = summarizeConversationSignals(signals);
    context.print(
      context.json
        ? JSON.stringify({ days, ...summary }, null, 2)
        : formatConversationReport(summary, days)
    );
    return summary;
  },
});

if (
  isDirectScript(import.meta.url, 'conversation_report.ts') ||
  isDirectScript(import.meta.url, 'conversation_report.js')
)
  void runConversationReport();
