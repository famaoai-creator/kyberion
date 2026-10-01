import { isInjectionSuspected } from '../untrusted-content.js';
import { resolveLocale } from '../locale.js';
import { normalizeLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import type { ClarificationFormatOptions } from './intent-contract-types.js';
import type { OperatorInteractionPacket } from '../contracts/operator-interaction-packet.js';

export function formatClarificationPacket(packet: OperatorInteractionPacket): string {
  const briefSummary =
    typeof (packet as any).execution_brief_summary === 'string' &&
    (packet as any).execution_brief_summary.trim().length > 0
      ? (packet as any).execution_brief_summary
      : undefined;
  const lines: string[] = [];
  if (isInjectionSuspected()) {
    lines.push(t('question:clarification_injection_warning'), '');
  }
  lines.push(packet.headline, packet.summary);
  if (briefSummary) lines.push('', `Brief: ${briefSummary}`);
  lines.push('', 'Required inputs:');
  for (const question of packet.questions || []) {
    lines.push(`- ${question.id}: ${question.question}`);
  }
  return lines.join('\n');
}

export function formatClarificationPacketConcise(
  packet: OperatorInteractionPacket,
  options: ClarificationFormatOptions = {}
): string {
  const locale = normalizeLocale(options.locale) ?? resolveLocale();
  const questions = packet.questions ?? [];
  const first = questions[0];
  const remaining = questions.length - 1;
  let warning = '';
  if (isInjectionSuspected()) {
    warning = `${t('question:clarification_injection_warning', undefined, locale)}\n`;
  }
  if (!first) {
    return warning + t('question:clarification_none_missing', undefined, locale);
  }
  const more =
    remaining > 0 ? t('question:clarification_more_hint', { count: remaining }, locale) : '';
  const lines = [
    t('question:clarification_next_required', { more, id: first.id }, locale),
    first.question,
  ];
  if (first.reason) {
    lines.push(t('question:clarification_reason_line', { reason: first.reason }, locale));
  }
  if (first.default_assumption) {
    lines.push(
      t('question:clarification_default_line', { value: first.default_assumption }, locale)
    );
  }
  return warning + lines.join('\n');
}
