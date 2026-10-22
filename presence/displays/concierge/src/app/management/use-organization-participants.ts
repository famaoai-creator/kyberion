'use client';

import * as React from 'react';
import { frontDeskFetch } from '../../lib/front-desk-fetch';
import {
  ManagementError,
  ManagementFence,
  type Scope,
  type ManagementData,
} from './management-client';
import {
  loadParticipants,
  submitParticipantCommand,
  type ParticipantsData,
  type ParticipantsCommand,
} from './participants-client';

type Notice = 'saved' | 'failed' | 'conflict' | 'expired' | 'forbidden' | 'uncertain';
/** The management page and this panel use the same identity and scope fence. */
export function useOrganizationParticipants(scope: Scope, management: ManagementData) {
  const [data, setData] = React.useState<ParticipantsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const sequence = React.useRef(0);
  const lock = React.useRef(false);
  const identity = React.useRef(new ManagementFence());
  const controller = React.useRef(new AbortController());
  const scopeKey = JSON.stringify([
    scope.tenant,
    scope.organizationId,
    management.contextId,
    management.actorId,
  ]);

  const reload = React.useCallback(async () => {
    controller.current.abort();
    controller.current = new AbortController();
    const signal = controller.current.signal;
    const id = ++sequence.current;
    const current = () =>
      id === sequence.current && !signal.aborted && !identity.current.authChanged();
    setData(null);
    setNotice(null);
    setLoading(true);
    try {
      const me = await frontDeskFetch('/api/me', { signal });
      if (!current()) return false;
      if (me.status === 401) throw new ManagementError('expired');
      if (
        !me.ok ||
        !identity.current.bindIdentity(await me.json()) ||
        !identity.current.acceptsSnapshot(management)
      )
        throw new ManagementError('forbidden');
      if (!current()) return false;
      const next = await loadParticipants(scope, management.contextId, signal);
      const matches = await identity.current.verifyIdentity(signal);
      if (!current()) return false;
      if (!matches || next.actorId !== management.actorId) throw new ManagementError('forbidden');
      setData(next);
      return true;
    } catch (error) {
      if (current()) setNotice(error instanceof ManagementError ? error.kind : 'failed');
      return false;
    } finally {
      if (id === sequence.current && !signal.aborted) setLoading(false);
    }
    // Scope values are frozen by the owning page and guarded again by contextId on the server.
  }, [scopeKey]);

  React.useEffect(() => {
    identity.current = new ManagementFence();
    void reload();
    return () => {
      sequence.current++;
      controller.current.abort();
      identity.current.reset();
    };
  }, [reload]);

  async function commit(command: ParticipantsCommand): Promise<boolean> {
    if (!data || lock.current || loading || identity.current.authChanged()) return false;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    const id = sequence.current;
    const signal = controller.current.signal;
    const current = () =>
      id === sequence.current && !signal.aborted && !identity.current.authChanged();
    let sent = false;
    try {
      if (!(await identity.current.verifyIdentity(signal))) throw new ManagementError('forbidden');
      if (!current()) return false;
      sent = true;
      await submitParticipantCommand(scope, data.contextId, command, signal);
      if (!(await identity.current.verifyIdentity(signal))) throw new ManagementError('forbidden');
      if (!current()) return false;
      const refreshed = await reload();
      if (signal.aborted && id !== sequence.current - 1) return false;
      if (!refreshed) return false;
      setNotice('saved');
      return true;
    } catch (error) {
      if (current()) {
        const kind = error instanceof ManagementError ? error.kind : sent ? 'uncertain' : 'failed';
        setNotice(kind);
        // A stale/uncertain write must be inspected by reloading before another mutation.
        setData(null);
      }
      return false;
    } finally {
      lock.current = false;
      if (id === sequence.current || id === sequence.current - 1) setBusy(false);
    }
  }
  return { data, loading, busy, notice, reload, commit };
}
