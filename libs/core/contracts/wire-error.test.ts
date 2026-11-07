import { describe, expect, it } from 'vitest';
import { formatWireError, toWireError } from './wire-error.js';

describe('wire-safe errors', () => {
  it('redacts internal error details while retaining a correlation id', () => {
    const error = new Error('secret tenant path /confidential/acme stack=PRIVATE');
    const safe = toWireError(error, 'corr-test-1');

    expect(safe).toEqual({
      code: 'internal',
      message: 'An internal error occurred. Use the correlation ID when contacting support.',
      correlation_id: 'corr-test-1',
    });
    expect(formatWireError(error, 'operation failed', 'corr-test-1')).not.toContain(
      'confidential/acme'
    );
  });

  it('maps protocol-safe classes without forwarding provider text', () => {
    expect(toWireError({ status: 404, message: 'file /private/secret.json not found' })).toEqual(
      expect.objectContaining({ code: 'not_found' })
    );
    expect(toWireError(new Error('MCP_APPROVAL_REQUIRED: token=secret'))).toEqual(
      expect.objectContaining({ code: 'invalid_request' })
    );
    expect(toWireError({ status: 501, message: 'raw implementation details' })).toEqual(
      expect.objectContaining({ code: 'not_implemented' })
    );
  });
});
