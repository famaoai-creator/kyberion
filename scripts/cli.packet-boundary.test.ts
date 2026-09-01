import { describe, expect, it } from 'vitest';
import { parseInteractionPacket } from './cli.js';

describe('cli packet boundary', () => {
  it('accepts a complete operator packet with typed actions', () => {
    expect(
      parseInteractionPacket({
        kind: 'operator-interaction-packet',
        interaction_type: 'execution-preview',
        headline: 'Ready',
        summary: 'A governed action is ready.',
        confidence: 0.9,
        next_actions: [
          {
            id: 'approve',
            action: 'Approve the plan',
            priority: 'now',
            next_action_type: 'execute_now',
          },
        ],
      })
    ).toMatchObject({ kind: 'operator-interaction-packet', next_actions: [{ id: 'approve' }] });
  });

  it('rejects malformed packet roots and nested action values', () => {
    expect(parseInteractionPacket([])).toBeUndefined();
    expect(
      parseInteractionPacket({
        kind: 'operator-interaction-packet',
        interaction_type: 'execution-preview',
        headline: 'Ready',
        summary: 'A governed action is ready.',
        next_actions: [{ id: 'approve', action: 'Approve', priority: 'danger' }],
      })
    ).toBeUndefined();
    expect(
      parseInteractionPacket({
        kind: 'system-status-report',
        headline: 'Status',
        summary: 'Summary',
        findings: [{ id: 'F-1', severity: 'high', message: 42 }],
      })
    ).toBeUndefined();
    expect(
      parseInteractionPacket({
        kind: 'operator-response-preview',
        format: 'plain-text',
        text: 'ok',
        constructor: { polluted: true },
      })
    ).toBeUndefined();
  });
});
