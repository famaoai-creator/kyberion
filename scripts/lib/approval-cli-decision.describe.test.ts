import { describe, expect, it } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { describeRequest } from './approval-cli-decision.js';

const request = (finalDecision: string, details?: string) =>
  ({
    id: 'APR-1',
    summary: "Allow one 'pnpm organization operation add' write to demo-hq",
    requestedBy: 'agent:claude-code',
    details,
    scope: { tenant_slug: 'calendar-demo' },
    accountability: {
      finalDecision,
      effectBinding: 'organization:write:calendar-demo:demo-hq:operation add',
    },
  }) as unknown as ApprovalRequestRecord;

describe('approval challenge description', () => {
  it('shows a human-only request its full details (the exact arguments) before the code', () => {
    const lines = describeRequest(
      request(
        'human_only',
        'Command: pnpm organization operation add\nArguments: {"name":"月次締め"}'
      ),
      'abc123'
    );
    expect(lines).toContain('  details:');
    expect(lines).toContain('    Arguments: {"name":"月次締め"}');
    expect(lines.at(-1)).toBe('  presented digest: abc123');
  });

  it('keeps other requests as before', () => {
    const lines = describeRequest(request('any', 'secret details'), 'abc123');
    expect(lines.join('\n')).not.toContain('details:');
  });
});
