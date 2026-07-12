import { describe, expect, it } from 'vitest';
import { validateSurfaceUxContract } from '../libs/core/surface-ux-contract.js';
import { formatOperatorPacketLines } from '../scripts/cli.js';

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/gu, '');

describe('operator output UX contract', () => {
  it('renders readiness and missing inputs without leaking raw enum values', () => {
    const text = formatOperatorPacketLines({
      kind: 'operator-interaction-packet',
      interaction_type: 'clarification',
      headline: 'Request: 月次レポートを作成します。',
      summary: 'Plan: 入力を確認してから結果を返します。',
      readiness: 'needs_clarification',
      confidence: 0.8,
      missing_inputs: ['対象期間'],
      omitted_question_count: 2,
      questions: [],
      next_actions: [],
    })
      .map(stripAnsi)
      .join('\n');

    expect(text).not.toContain('needs_clarification');
    expect(text).toContain('対象期間');
    expect(text).toContain('2');
    expect(validateSurfaceUxContract({ text }).valid).toBe(true);
  });
});
