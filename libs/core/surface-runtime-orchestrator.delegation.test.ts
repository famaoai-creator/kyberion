import { describe, expect, it } from 'vitest';

import {
  buildDelegationSummaryContext,
  extractFollowUpRequests,
} from './surface-runtime-orchestrator.js';

describe('surface-runtime-orchestrator delegation translation', () => {
  it('extracts follow-up requests from delegated responses', () => {
    const requests = extractFollowUpRequests([
      'I can handle this, but could you confirm the target date?',
      '',
      'Also, please share the preferred channel.',
    ].join('\n'));

    expect(requests).toEqual([
      'I can handle this, but could you confirm the target date?',
      'Also, please share the preferred channel.',
    ]);
  });

  it('includes follow-up requests in the delegation summary context', () => {
    const context = buildDelegationSummaryContext({
      originalQuery: '進めて',
      delegationResults: [
        {
          receiver: 'chronos-mirror',
          response: 'I can proceed, but could you confirm the target date?',
        },
        {
          receiver: 'nerve-agent',
          response: 'Task routing is ready.',
        },
      ],
    });

    expect(context).toContain('Follow-up requests from delegated work:');
    expect(context).toContain('chronos-mirror: I can proceed, but could you confirm the target date?');
  });
});
