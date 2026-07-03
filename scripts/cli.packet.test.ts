import { describe, expect, it } from 'vitest';
import { formatOperatorPacketLines } from './cli.js';

describe('cli packet formatting', () => {
  it('renders missing inputs and omitted clarification counts', () => {
    const lines = formatOperatorPacketLines({
      kind: 'operator-interaction-packet',
      interaction_type: 'clarification',
      headline: 'Clarification needed',
      summary: 'The request needs more detail before execution can continue.',
      readiness: 'needs_clarification',
      missing_inputs: ['meeting_url', 'meeting_role_boundary'],
      omitted_question_count: 2,
      questions: [
        {
          id: 'meeting_url',
          question: 'Please provide meeting url.',
          reason: 'The request cannot be executed safely without this input.',
        },
      ],
    });

    const rendered = lines.join('\n');
    expect(rendered).toMatch(
      /(Missing inputs|不足している入力): meeting_url, meeting_role_boundary/
    );
    expect(rendered).toMatch(
      /(There are 2 more clarification items\.|他に 2 件の確認事項があります。)/
    );
    expect(rendered).toMatch(/(Questions|質問):/);
  });
});
