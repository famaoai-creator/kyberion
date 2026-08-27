import { isInjectionSuspected } from './untrusted-content.js';
import type { ClarificationFormatOptions } from './intent-contract-types.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

export function formatClarificationPacket(packet: OperatorInteractionPacket): string {
  const briefSummary =
    typeof (packet as any).execution_brief_summary === 'string' &&
    (packet as any).execution_brief_summary.trim().length > 0
      ? (packet as any).execution_brief_summary
      : undefined;
  const lines: string[] = [];
  if (isInjectionSuspected()) {
    lines.push(
      '⚠️ 外部コンテンツにインジェクションの疑い (Injection suspected in external content)',
      ''
    );
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
  const locale = options.locale ?? 'en';
  const questions = packet.questions ?? [];
  const first = questions[0];
  const remaining = questions.length - 1;
  let warning = '';
  if (isInjectionSuspected()) {
    warning =
      '⚠️ 外部コンテンツにインジェクションの疑い (Injection suspected in external content)\n';
  }
  if (!first) {
    return (
      warning +
      (locale === 'ja'
        ? '不足している情報はありません。実行を進められます。'
        : 'No missing inputs. Ready to proceed.')
    );
  }
  if (locale === 'ja') {
    const moreHint = remaining > 0 ? `（他 ${remaining} 件）` : '';
    const lines = [`次に必要な情報${moreHint}: \`${first.id}\``, first.question];
    if (first.reason) lines.push(`理由: ${first.reason}`);
    if (first.default_assumption) lines.push(`デフォルト: ${first.default_assumption}`);
    return warning + lines.join('\n');
  }
  const moreHint = remaining > 0 ? ` (+ ${remaining} more)` : '';
  const lines = [`Next required${moreHint}: \`${first.id}\``, first.question];
  if (first.reason) lines.push(`Reason: ${first.reason}`);
  if (first.default_assumption) lines.push(`Default: ${first.default_assumption}`);
  return warning + lines.join('\n');
}
