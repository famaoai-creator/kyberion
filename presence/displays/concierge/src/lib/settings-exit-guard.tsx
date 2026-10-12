'use client';

import * as React from 'react';
import { A2UIActionProvider, Dialog } from '@agent/shared-ui';
import { useConciergeI18n } from './use-concierge-i18n';

export interface SettingsExitRegistration {
  dirty: boolean;
  saving: boolean;
  /** The synchronous save fence also covers a save started before React commits. */
  isSaving: () => boolean;
  valid: boolean;
  /** Restore the page-owned baselines, returning false if discard is no longer safe. */
  discard: () => boolean;
}

interface Registration {
  read: () => SettingsExitRegistration;
}
interface PendingLeave {
  registration: Registration;
  proceed: () => void;
}
interface SettingsExitGuard {
  requestLeave: (href: string, proceed: () => void) => void;
}
interface GuardContext extends SettingsExitGuard {
  register: (registration: Registration) => void;
  update: (registration: Registration) => void;
  unregister: (registration: Registration) => void;
}

const SettingsExitContext = React.createContext<GuardContext | null>(null);
const unguarded: SettingsExitGuard = { requestLeave: (_href, proceed) => proceed() };

/** Only a same-document fragment change bypasses the guard; query context must match. */
function isHashNavigation(href: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const current = new URL(window.location.href);
    const destination = new URL(href, current);
    return (
      current.origin === destination.origin &&
      current.pathname === destination.pathname &&
      current.search === destination.search &&
      (current.hash !== destination.hash || destination.hash !== '')
    );
  } catch {
    return false;
  }
}

/**
 * Shell-owned navigation coordination only. Draft values, receipts and baselines
 * remain in Settings; this provider holds callbacks and at most one destination.
 * Browser history is untouched. beforeunload is best-effort browser protection.
 */
export function SettingsExitGuardProvider({ children }: { children?: React.ReactNode }) {
  const { t } = useConciergeI18n();
  const registrationRef = React.useRef<Registration | null>(null);
  const pendingRef = React.useRef<PendingLeave | null>(null);
  const mountedRef = React.useRef(true);
  const unloadAttachedRef = React.useRef(false);
  const [pending, setPending] = React.useState<PendingLeave | null>(null);
  const [, refresh] = React.useReducer((value: number) => value + 1, 0);

  const beforeUnload = React.useCallback((event: BeforeUnloadEvent) => {
    const state = registrationRef.current?.read();
    if (!state?.valid || (!state.dirty && !state.saving && !state.isSaving())) return;
    event.preventDefault();
    // Browsers select their own warning text, and may choose not to show one.
    event.returnValue = '';
  }, []);
  const removeBeforeUnload = React.useCallback(() => {
    if (unloadAttachedRef.current && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', beforeUnload);
      unloadAttachedRef.current = false;
    }
  }, [beforeUnload]);
  const syncBeforeUnload = React.useCallback(() => {
    const state = registrationRef.current?.read();
    const protectedState = state?.valid && (state.dirty || state.saving || state.isSaving());
    if (!protectedState) removeBeforeUnload();
    else if (!unloadAttachedRef.current && typeof window !== 'undefined') {
      window.addEventListener('beforeunload', beforeUnload);
      unloadAttachedRef.current = true;
    }
  }, [beforeUnload, removeBeforeUnload]);

  const cancel = React.useCallback((expected?: PendingLeave) => {
    if (expected && pendingRef.current !== expected) return;
    pendingRef.current = null;
    if (mountedRef.current) setPending(null);
  }, []);
  const unregister = React.useCallback(
    (registration: Registration) => {
      if (registrationRef.current !== registration) return;
      registrationRef.current = null;
      cancel();
      removeBeforeUnload();
    },
    [cancel, removeBeforeUnload]
  );
  const register = React.useCallback(
    (registration: Registration) => {
      // Child layout effects replay before the parent in StrictMode.
      if (registrationRef.current !== registration) cancel();
      registrationRef.current = registration;
      syncBeforeUnload();
    },
    [cancel, syncBeforeUnload]
  );
  const update = React.useCallback(
    (registration: Registration) => {
      if (registrationRef.current !== registration) return;
      const state = registration.read();
      if (!state.valid) {
        unregister(registration);
        return;
      }
      syncBeforeUnload();
      // A fully acknowledged save ends this intent without navigating. Keeping
      // a discard warning after the page is clean would misdescribe the outcome.
      if (!state.dirty && !state.saving && !state.isSaving()) cancel();
      else if (pendingRef.current) refresh();
    },
    [cancel, syncBeforeUnload, unregister]
  );
  const requestLeave = React.useCallback(
    (href: string, proceed: () => void) => {
      if (!mountedRef.current) return;
      cancel();
      const registration = registrationRef.current;
      const state = registration?.read();
      if (
        !registration ||
        !state?.valid ||
        isHashNavigation(href) ||
        (!state.dirty && !state.saving && !state.isSaving())
      ) {
        proceed();
        return;
      }
      const next = { registration, proceed };
      pendingRef.current = next;
      setPending(next);
    },
    [cancel]
  );
  const confirm = (expected: PendingLeave) => {
    if (pendingRef.current !== expected || registrationRef.current !== expected.registration)
      return;
    const state = expected.registration.read();
    if (!state.valid || state.saving || state.isSaving()) return;
    if (!state.discard()) return;
    // A synchronous invalidation from discard must not resurrect the destination.
    if (pendingRef.current !== expected || registrationRef.current !== expected.registration)
      return;
    const latest = expected.registration.read();
    if (!latest.valid || latest.saving || latest.isSaving()) return;
    cancel(expected);
    // React may not have committed discard yet. Release the native warning now,
    // before the caller performs a hard navigation; later edits re-arm on update.
    removeBeforeUnload();
    expected.proceed();
  };

  React.useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      registrationRef.current = null;
      pendingRef.current = null;
      removeBeforeUnload();
    };
  }, [removeBeforeUnload]);

  const context = React.useMemo(
    () => ({ requestLeave, register, update, unregister }),
    [requestLeave, register, update, unregister]
  );
  const state = pending?.registration.read();
  const saving = Boolean(state?.saving || state?.isSaving());
  return (
    <SettingsExitContext.Provider value={context}>
      {children}
      <A2UIActionProvider
        onAction={(id, payload) => {
          if (!pending) return;
          if (id === 'settings.leave.cancel' || payload?.choice === 'stay') cancel(pending);
          else if (id === 'settings.leave.choose' && payload?.choice === 'discard')
            confirm(pending);
        }}
      >
        <Dialog
          key={saving ? 'saving' : 'dirty'}
          id="settings-leave"
          open={pending !== null}
          title={t('setup.leave_title')}
          message={t(saving ? 'setup.leave_saving_message' : 'setup.leave_message')}
          action={{ id: 'settings.leave.choose' }}
          cancel_action={{ id: 'settings.leave.cancel' }}
          choices={[
            { id: 'stay', label: t('setup.leave_stay'), variant: 'primary' },
            ...(!saving
              ? [{ id: 'discard', label: t('setup.leave_discard'), variant: 'danger' as const }]
              : []),
          ]}
        />
      </A2UIActionProvider>
    </SettingsExitContext.Provider>
  );
}

export function useSettingsExitGuard(): SettingsExitGuard {
  return React.useContext(SettingsExitContext) ?? unguarded;
}

/** Register before page early returns; invalidate before clearing an identity/auth context. */
export function useSettingsExitRegistration(options: SettingsExitRegistration) {
  const guard = React.useContext(SettingsExitContext);
  const latest = React.useRef(options);
  latest.current = options;
  const invalidated = React.useRef(false);
  const [registration] = React.useState<Registration>(() => ({ read: () => latest.current }));
  React.useLayoutEffect(() => {
    if (!options.valid || invalidated.current) return;
    guard?.register(registration);
    return () => guard?.unregister(registration);
  }, [guard, registration, options.valid]);
  React.useLayoutEffect(() => {
    // A newer edit can keep dirty=true in the same commit as an accepted
    // discard. Re-arm on every page commit, not just boolean transitions.
    guard?.update(registration);
  });
  const invalidate = React.useCallback(() => {
    invalidated.current = true;
    guard?.unregister(registration);
  }, [guard, registration]);
  return React.useMemo(() => ({ invalidate }), [invalidate]);
}

/** Native anchors share the same guard without changing new-tab or download behavior. */
export function GuardedAnchor({ href, onClick, ...props }: React.ComponentProps<'a'>) {
  const { requestLeave } = useSettingsExitGuard();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          !href ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (props.target && props.target !== '_self') ||
          (props.download !== undefined && props.download !== false)
        )
          return;
        try {
          const destination = new URL(href, window.location.href);
          if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return;
        } catch {
          return;
        }
        event.preventDefault();
        requestLeave(href, () => window.location.assign(href));
      }}
    />
  );
}
