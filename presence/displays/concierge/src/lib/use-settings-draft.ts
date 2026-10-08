'use client';

import * as React from 'react';
import { parseSettingsMe } from './settings-types';

/** Keep editable values separate from the last server-acknowledged snapshot. */
export function useSettingsDraft<T>(initial: T, equal: (a: T, b: T) => boolean) {
  const [state, setState] = React.useState<{ draft: T; saved: T | null; edited: boolean }>({
    draft: initial,
    saved: null,
    edited: false,
  });
  const initialRef = React.useRef(initial);
  const clear = React.useCallback(
    () => setState({ draft: initialRef.current, saved: null, edited: false }),
    []
  );
  const equalRef = React.useRef(equal);
  equalRef.current = equal;
  const set = React.useCallback<React.Dispatch<React.SetStateAction<T>>>((value) => {
    setState((current) => ({
      ...current,
      edited: true,
      draft: typeof value === 'function' ? (value as (previous: T) => T)(current.draft) : value,
    }));
  }, []);
  const load = React.useCallback((saved: T) => {
    setState((current) => ({
      saved,
      edited: current.edited,
      draft: (
        current.saved === null ? !current.edited : equalRef.current(current.draft, current.saved)
      )
        ? saved
        : current.draft,
    }));
  }, []);
  const acknowledge = React.useCallback((submitted: T, saved = submitted) => {
    setState((current) => ({
      saved,
      edited: current.edited,
      draft: equalRef.current(current.draft, submitted) ? saved : current.draft,
    }));
  }, []);
  const discard = React.useCallback(
    () =>
      setState((current) =>
        current.saved === null
          ? { draft: initialRef.current, saved: null, edited: false }
          : { ...current, draft: current.saved, edited: false }
      ),
    []
  );
  return { ...state, set, load, acknowledge, discard, clear };
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Existing /api/me projection. Never use profile display text as draft ownership. */
export function settingsDraftContext(value: unknown): string | undefined {
  if (!record(value) || !parseSettingsMe(value) || !record(value.member)) return undefined;
  const member = value.member;
  if (
    typeof member.member_id !== 'string' ||
    !member.member_id.trim() ||
    !['loopback', 'token'].includes(String(member.source)) ||
    typeof member.registered !== 'boolean' ||
    !(value.write_tenant === null || typeof value.write_tenant === 'string') ||
    !strings(value.available_operations)
  )
    return undefined;
  const me = parseSettingsMe(value)!;
  return JSON.stringify([
    member.member_id,
    member.source,
    member.registered,
    value.write_tenant,
    me.viewing ? [me.viewing.tenant_slug, me.viewing.role, me.viewing.status] : null,
    me.tenants
      .map(({ tenant_slug, role, status }) => [tenant_slug, role, status])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [...value.available_operations].sort(),
  ]);
}

export function isOnboardingSaveReceipt(value: unknown): boolean {
  return (
    record(value) &&
    value.ok === true &&
    record(value.onboarding) &&
    value.onboarding.ok === true &&
    typeof value.onboarding.applied_at === 'string' &&
    strings(value.onboarding.artifacts) &&
    strings(value.onboarding.warnings)
  );
}

export function notificationSaveReceipt(
  value: unknown
): { surface: string; target: string } | null | undefined {
  if (!record(value) || value.ok !== true || !record(value.preferences)) return undefined;
  const channel = value.preferences.default_channel;
  if (channel === null) return null;
  if (!record(channel) || typeof channel.surface !== 'string' || typeof channel.target !== 'string')
    return undefined;
  return { surface: channel.surface, target: channel.target };
}

/** Client fence, not an atomic server-side identity binding or authorization. */
export function useSettingsDraftSession(onInvalidated: () => void) {
  const callback = React.useRef(onInvalidated);
  callback.current = onInvalidated;
  const state = React.useRef({
    active: true,
    invalid: false,
    epoch: 0,
    context: undefined as string | undefined,
    reads: new Map<string, number>(),
  });
  const session = React.useMemo(() => {
    const invalidate = () => {
      if (!state.current.active || state.current.invalid) return;
      state.current.invalid = true;
      state.current.epoch++;
      callback.current();
    };
    const current = (epoch: number) =>
      state.current.active && !state.current.invalid && state.current.epoch === epoch;
    const check = async (epoch = state.current.epoch) => {
      if (!current(epoch)) return false;
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!current(epoch)) return false;
      if (response.status === 401 || response.status === 403) {
        invalidate();
        return false;
      }
      const context = settingsDraftContext(await response.json().catch(() => null));
      if (!current(epoch)) return false;
      if (!response.ok || !context) throw new Error('settings_context_unavailable');
      if (state.current.context !== undefined && state.current.context !== context) {
        invalidate();
        return false;
      }
      state.current.context = context;
      return true;
    };
    return {
      current,
      check,
      invalidate,
      epoch: () => state.current.epoch,
      advance: (key: string) => {
        state.current.reads.set(key, (state.current.reads.get(key) ?? 0) + 1);
      },
      startRead: (key: string) => {
        const seq = (state.current.reads.get(key) ?? 0) + 1;
        state.current.reads.set(key, seq);
        const epoch = state.current.epoch;
        return () => current(epoch) && state.current.reads.get(key) === seq;
      },
      inspect: (response: Response) => {
        if (response.status === 401 || response.status === 403) {
          invalidate();
          return false;
        }
        return true;
      },
    };
  }, []);
  React.useEffect(() => {
    state.current.active = true;
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) session.invalidate();
    };
    window.addEventListener('pageshow', restored);
    return () => {
      state.current.active = false;
      state.current.epoch++;
      window.removeEventListener('pageshow', restored);
    };
  }, [session]);
  return session;
}
