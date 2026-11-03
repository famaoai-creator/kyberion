import { afterEach, describe, expect, it, vi } from 'vitest';
import { openServiceConsentWindow } from '../src/lib/oauth-popup';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openServiceConsentWindow', () => {
  it('keeps the popup handle while stripping opener access', () => {
    const popup = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.fn().mockReturnValue(popup);
    vi.stubGlobal('window', { ...globalThis.window, open });
    const handle = openServiceConsentWindow();
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(open.mock.calls[0][2]).toBeUndefined();
    expect(handle).toBe(popup);
    expect(handle!.opener).toBeNull();
    handle!.location.href = 'https://provider.example/consent';
    expect(popup.location.href).toBe('https://provider.example/consent');
  });

  it('returns null when the browser blocks the popup so callers fall back to same-tab navigation', () => {
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal('window', { ...globalThis.window, open });
    expect(openServiceConsentWindow()).toBeNull();
  });
});
