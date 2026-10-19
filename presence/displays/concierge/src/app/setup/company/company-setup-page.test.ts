import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialCompanyState } from './company-setup-model';

const harness = vi.hoisted(() => ({
  state: {} as ReturnType<typeof initialCompanyState>,
  tenant: 'company-a',
  controller: {
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    load: vi.fn(),
    refresh: vi.fn(),
    act: vi.fn(),
    updateDraft: vi.fn(),
    dismissReview: vi.fn(),
    contextChanged: vi.fn(),
    suspend: vi.fn(),
    verifyIdentity: vi.fn(),
    dispose: vi.fn(),
  },
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  },
}));
vi.mock('../../../lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../lib/tenant-context', () => ({
  TENANT_CHANGED_EVENT: 'front-desk:tenant-changed',
  readSelectedTenant: () => harness.tenant,
  tenantFromChangeEvent: (event: CustomEvent<{ tenant?: string }>) => event.detail?.tenant ?? null,
}));
vi.mock('./company-setup-client', () => ({
  createCompanySetupController: () => harness.controller,
}));
import CompanySetupPage from './page';

let target: EventTarget & {
  location: { pathname: string; search: string };
  history: { state: null; replaceState: ReturnType<typeof vi.fn> };
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  harness.cleanups.length = 0;
  harness.tenant = 'company-a';
  harness.state = initialCompanyState('company-a');
  harness.controller.getSnapshot.mockImplementation(() => harness.state);
  target = Object.assign(new EventTarget(), {
    location: { pathname: '/setup/company', search: '?tenant=company-a' },
    history: { state: null, replaceState: vi.fn() },
    setInterval,
    clearInterval,
  });
  vi.stubGlobal('window', target);
});
afterEach(() => {
  harness.cleanups.forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('company setup page navigation wiring (synthetic events)', () => {
  it('loads the selected tenant once and keeps focus checks read-only', () => {
    CompanySetupPage();
    expect(harness.controller.load).toHaveBeenCalledExactlyOnceWith('company-a');
    target.dispatchEvent(new Event('focus'));
    expect(harness.controller.verifyIdentity).toHaveBeenCalledOnce();
    expect(harness.controller.load).toHaveBeenCalledTimes(1);
    expect(harness.controller.act).not.toHaveBeenCalled();
  });
  it('changes tenant with a credential-free URL and uses guarded explicit refresh', () => {
    const tree = CompanySetupPage();
    tree.props.changeTenant('company-b');
    expect(target.history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      '/setup/company?tenant=company-b'
    );
    expect(harness.controller.load).toHaveBeenLastCalledWith('company-b');
    tree.props.refresh();
    expect(harness.controller.refresh).toHaveBeenCalledOnce();
  });
  it('handles back/forward, company events, page restoration, and page hiding', () => {
    CompanySetupPage();
    harness.tenant = 'company-b';
    target.dispatchEvent(new Event('popstate'));
    expect(harness.controller.load).toHaveBeenLastCalledWith('company-b');
    target.dispatchEvent(
      new CustomEvent('front-desk:tenant-changed', { detail: { tenant: 'company-c' } })
    );
    expect(harness.controller.load).toHaveBeenLastCalledWith('company-c');
    target.dispatchEvent(new Event('pagehide'));
    expect(harness.controller.suspend).toHaveBeenCalledOnce();
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(harness.controller.load).toHaveBeenLastCalledWith('company-b');
  });
  it('invalidates changed credentials and removes listeners on unmount', () => {
    CompanySetupPage();
    harness.controller.contextChanged.mockReturnValue(true);
    target.dispatchEvent(new Event('storage'));
    expect(harness.controller.suspend).toHaveBeenCalledOnce();
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(harness.controller.dispose).toHaveBeenCalledOnce();
    target.dispatchEvent(new Event('focus'));
    expect(harness.controller.verifyIdentity).not.toHaveBeenCalled();
  });
});
