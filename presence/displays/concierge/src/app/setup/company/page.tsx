'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import {
  TENANT_CHANGED_EVENT,
  readSelectedTenant,
  tenantFromChangeEvent,
} from '../../../lib/tenant-context';
import { createCompanySetupController } from './company-setup-client';
import { companySetupHref } from './company-setup-model';
import { CompanySetupView } from './CompanySetupView';
import '../../settings/settings.css';

export default function CompanySetupPage() {
  const { t } = useConciergeI18n();
  const controller = React.useMemo(() => createCompanySetupController(), []);
  const state = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  React.useEffect(() => {
    const refresh = () => void controller.load(readSelectedTenant() ?? '');
    const changed = (event: Event) => {
      const tenant = tenantFromChangeEvent(event) ?? readSelectedTenant() ?? '';
      void controller.load(tenant);
    };
    const guard = () => {
      if (controller.contextChanged()) controller.suspend();
    };
    const focus = () => {
      guard();
      void controller.verifyIdentity();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const hide = () => controller.suspend();
    refresh();
    window.addEventListener(TENANT_CHANGED_EVENT, changed);
    window.addEventListener('popstate', changed);
    window.addEventListener('storage', guard);
    window.addEventListener('focus', focus);
    window.addEventListener('pageshow', restore);
    window.addEventListener('pagehide', hide);
    const timer = window.setInterval(guard, 1000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(TENANT_CHANGED_EVENT, changed);
      window.removeEventListener('popstate', changed);
      window.removeEventListener('storage', guard);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('pagehide', hide);
      controller.dispose();
    };
  }, [controller]);
  return (
    <CompanySetupView
      state={state}
      t={t}
      changeTenant={(tenant) => {
        window.history.replaceState(window.history.state, '', companySetupHref(tenant));
        void controller.load(tenant);
      }}
      updateDraft={controller.updateDraft}
      act={(action) => void controller.act(action)}
      refresh={() => void controller.refresh()}
      dismissReview={controller.dismissReview}
    />
  );
}
