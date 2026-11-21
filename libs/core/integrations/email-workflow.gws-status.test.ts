import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ output: '' }));

vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeExec: () => mocks.output,
}));

const { readGwsAuthStatus } = await import('./email-workflow.js');

describe('readGwsAuthStatus token state', () => {
  beforeEach(() => {
    mocks.output = '';
  });

  it('marks a stored login whose refresh was refused, without keeping the error text', () => {
    // `gws auth status` for a revoked refresh token.
    mocks.output = JSON.stringify({
      encrypted_credentials_exists: true,
      token_cache_exists: true,
      has_refresh_token: true,
      token_valid: false,
      token_error: 'Bad Request',
    });
    const status = readGwsAuthStatus();
    expect(status).toMatchObject({ ok: true, token_valid: false, token_refresh_failed: true });
    expect(JSON.stringify(status)).not.toContain('Bad Request');
  });

  it.each(['invalid_grant: Bad Request', 'Unauthorized', 'HTTP 401'])(
    'treats the refusal %s as a refused refresh',
    (tokenError) => {
      mocks.output = JSON.stringify({ token_valid: false, token_error: tokenError });
      expect(readGwsAuthStatus()).toMatchObject({ token_refresh_failed: true });
    }
  );

  it.each(['error sending request: dns error', 'operation timed out'])(
    'does not treat the unreachable-server error %s as a refusal',
    (tokenError) => {
      mocks.output = JSON.stringify({ token_valid: false, token_error: tokenError });
      expect(readGwsAuthStatus()).toMatchObject({ token_refresh_failed: false });
    }
  );

  it('does not call an unchecked token a refusal', () => {
    mocks.output = JSON.stringify({ encrypted_credentials_exists: true, token_valid: false });
    expect(readGwsAuthStatus()).toMatchObject({ token_valid: false, token_refresh_failed: false });
  });

  it('keeps token_valid null when gws does not report it', () => {
    mocks.output = JSON.stringify({ encrypted_credentials_exists: true });
    expect(readGwsAuthStatus()).toMatchObject({ token_valid: null, token_refresh_failed: false });
  });
});
