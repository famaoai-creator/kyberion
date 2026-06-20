import { describe, expect, it } from 'vitest';
import { summarizeApprovalGate } from '../libs/core/approval-gate-summary.js';

describe('approval gate summary', () => {
  it('renders approval-free results clearly', () => {
    expect(
      summarizeApprovalGate({
        taskId: 'email-triage',
        artifacts: ['email-triage.md', 'reply-drafts.json'],
        approvalBoundary: {
          requiredFor: [],
          defaultAction: 'draft-only',
        },
      }),
    ).toBe(
      [
        'Task: email-triage',
        '',
        'Result:',
        '- Created email-triage.md',
        '- Created reply-drafts.json',
        '',
        'Approval required:',
        '- none',
        '',
        'Default action:',
        '- draft-only; no external delivery was performed',
      ].join('\n'),
    );
  });

  it('accepts the internal underscore-style approval value as well', () => {
    expect(
      summarizeApprovalGate({
        taskId: 'weekly-digest',
        artifacts: ['weekly-executive-digest.md'],
        approvalBoundary: {
          requiredFor: ['external_sharing'],
          defaultAction: 'notify_only',
        },
      }),
    ).toContain('- notify-only; no external delivery was performed');
  });

  it('renders approval-required results clearly', () => {
    expect(
      summarizeApprovalGate({
        taskId: 'meeting-to-proposal-pptx',
        artifacts: ['deck-brief.json', 'proposal-deck.pptx'],
        approvalBoundary: {
          requiredFor: ['send_to_customer'],
          defaultAction: 'requires-human-approval',
        },
      }),
    ).toBe(
      [
        'Task: meeting-to-proposal-pptx',
        '',
        'Result:',
        '- Created deck-brief.json',
        '- Created proposal-deck.pptx',
        '',
        'Approval required:',
        '- send_to_customer',
        '',
        'Default action:',
        '- requires-human-approval; no external delivery was performed',
      ].join('\n'),
    );
  });

  it('renders missing artifact cases without ambiguity', () => {
    expect(
      summarizeApprovalGate({
        taskId: 'draft-only-task',
        artifacts: [],
      }),
    ).toContain('- No artifacts recorded');
  });
});
