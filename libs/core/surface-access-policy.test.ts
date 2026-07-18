import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeSurfaceAllowlistConfiguration,
  evaluateSurfaceActorAccess,
} from './surface-access-policy.js';

describe('surface-access-policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the common JSON allowlist for every surface', () => {
    vi.stubEnv(
      'KYBERION_SURFACE_ALLOWLISTS',
      JSON.stringify({ slack: ['U123'], discord: { actors: ['D456'] } })
    );

    expect(evaluateSurfaceActorAccess('slack', 'U123').allowed).toBe(true);
    expect(evaluateSurfaceActorAccess('slack', 'U999').reason).toBe('not_allowlisted');
    expect(evaluateSurfaceActorAccess('discord', 'D456').allowed).toBe(true);
    expect(describeSurfaceAllowlistConfiguration('discord')).toEqual({
      configured: true,
      source: 'common',
    });
  });

  it('preserves legacy Telegram configuration as a fallback', () => {
    vi.stubEnv('TELEGRAM_ALLOWED_USER_IDS', '123, 456');
    expect(evaluateSurfaceActorAccess('telegram', '123').allowed).toBe(true);
    expect(evaluateSurfaceActorAccess('telegram', '999').allowed).toBe(false);
    expect(evaluateSurfaceActorAccess('telegram', '999').source).toBe('legacy');
  });

  it('preserves deny-by-default for unconfigured Telegram and open defaults elsewhere', () => {
    expect(evaluateSurfaceActorAccess('telegram', '123').allowed).toBe(false);
    expect(evaluateSurfaceActorAccess('slack', 'U123').allowed).toBe(true);
    expect(evaluateSurfaceActorAccess('discord', 'D123').allowed).toBe(true);
    expect(evaluateSurfaceActorAccess('imessage', 'alice@example.com').allowed).toBe(true);
  });

  it('leaves surfaces omitted from a partial common map on their existing defaults', () => {
    vi.stubEnv('KYBERION_SURFACE_ALLOWLISTS', JSON.stringify({ slack: ['U123'] }));
    expect(evaluateSurfaceActorAccess('slack', 'U999').allowed).toBe(false);
    expect(evaluateSurfaceActorAccess('discord', 'D123')).toMatchObject({
      allowed: true,
      configured: false,
      source: 'default',
    });
    expect(evaluateSurfaceActorAccess('telegram', '123')).toMatchObject({
      allowed: false,
      configured: false,
      source: 'default',
    });
  });

  it('fails closed for malformed common configuration', () => {
    vi.stubEnv('KYBERION_SURFACE_ALLOWLISTS', '{bad json');
    expect(evaluateSurfaceActorAccess('slack', 'U123')).toMatchObject({
      allowed: false,
      configured: true,
      source: 'invalid',
      reason: 'invalid_allowlist',
    });
  });
});
