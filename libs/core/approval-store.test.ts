import { describe, expect, it } from 'vitest';
import { approvalEventLogicalPath, approvalRequestLogicalPath } from './approval-store.js';

describe('approval-store path normalization', () => {
  it('rejects invalid approval channels', () => {
    expect(() => approvalRequestLogicalPath('../secret', '123e4567-e89b-12d3-a456-426614174000')).toThrow(
      'Invalid approval channel',
    );
    expect(() => approvalEventLogicalPath('terminal/../slack')).toThrow('Invalid approval channel');
  });

  it('rejects invalid approval request ids', () => {
    expect(() => approvalRequestLogicalPath('terminal', '../escape')).toThrow('Invalid approval request id');
  });
});
