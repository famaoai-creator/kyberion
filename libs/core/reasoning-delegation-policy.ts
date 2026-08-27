/** Delegation summary retry policy and continuation prompt construction. */

import { getRegisteredEnvText } from './foundation/env.js';

export const DELEGATION_SUMMARY_MIN_CHARS = 200;

/**
 * Shared first line of every delegateStructured prompt. The summary-retry
 * gate uses it to recognize structured delegations, which own their own
 * schema-validation retry loop and are judged by schema fit, not report length.
 */
export const STRUCTURED_DELEGATION_PROMPT_HEADER =
  'Return a single JSON object that satisfies the schema below.';

export function delegationSummaryRetryEnabled(): boolean {
  const raw = (getRegisteredEnvText('KYBERION_DELEGATION_SUMMARY_RETRY') || '')
    .trim()
    .toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

export function buildDelegationSummaryContinuationPrompt(
  instruction: string,
  briefResult: string
): string {
  return [
    'Your previous final report for the delegated task below was too brief to act on.',
    'Continue the same task and produce a comprehensive final report with concrete',
    'evidence: what was done, artifact/file paths, verification performed and its',
    'results, and any unresolved gaps. Do not restart the task from scratch.',
    '',
    'Original instruction:',
    instruction,
    '',
    'Your too-brief report:',
    briefResult,
  ].join('\n');
}
