import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSigninRequestGuard } from './signin-request-guard';

const auth = vi.hoisted(() => ({ revision: 0 }));
vi.mock('./front-desk-auth-token', () => ({
  getFrontDeskAuthRevision: () => auth.revision,
}));

beforeEach(() => {
  auth.revision = 0;
  vi.stubGlobal('window', {
    location: { pathname: '/signin', search: '?next=%2Fsettings', hash: '' },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-in request guard', () => {
  it('locks synchronously until the active attempt finishes', () => {
    const guard = createSigninRequestGuard();
    const first = guard.begin()!;
    expect(first.current()).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(guard.begin()).toBeNull();
    first.finish();
    const second = guard.begin()!;
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
  });

  it('aborts and invalidates an attempt on cancel, then permits a new attempt', () => {
    const guard = createSigninRequestGuard();
    const first = guard.begin()!;
    guard.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(guard.begin()!.current()).toBe(true);
  });

  it('does not let a cancelled attempt release a newer attempt lock', () => {
    const guard = createSigninRequestGuard();
    const first = guard.begin()!;
    guard.cancel();
    const second = guard.begin()!;
    first.finish();
    expect(guard.begin()).toBeNull();
    expect(second.current()).toBe(true);
    second.finish();
    expect(guard.begin()).not.toBeNull();
  });

  it('invalidates an attempt when a newer authentication operation occurs', () => {
    const attempt = createSigninRequestGuard().begin()!;
    auth.revision++;
    expect(attempt.current()).toBe(false);
  });

  it.each(['pathname', 'search'] as const)(
    'invalidates an attempt after navigation changes %s',
    (part) => {
      const attempt = createSigninRequestGuard().begin()!;
      window.location[part] = part === 'pathname' ? '/settings' : '?next=%2Fmembers';
      expect(attempt.current()).toBe(false);
    },
  );

  it('does not invalidate an attempt for an in-page fragment change', () => {
    const attempt = createSigninRequestGuard().begin()!;
    window.location.hash = '#help';
    expect(attempt.current()).toBe(true);
  });

  it('allows cancel before any request or after settlement', () => {
    const guard = createSigninRequestGuard();
    guard.cancel();
    guard.begin()!.finish();
    guard.cancel();
    const attempt = guard.begin()!;
    expect(attempt.current()).toBe(true);
    expect(attempt.signal.aborted).toBe(false);
  });
});
