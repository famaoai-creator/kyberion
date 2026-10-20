'use client';

import { frontDeskFetch as fetch } from './front-desk-fetch';

import * as React from 'react';
import { workspaceSelectionFromQuery } from '@agent/core/surface/workspace-query';
import type { ConciergeMessageKey } from './i18n';
import { parseSetupResponse } from './setup-response';
import {
  parseConciergeIngestError,
  parseConciergeIngestResponse,
  type ConciergeIngestSummary,
} from './ingest-response';

type Selection = {
  file: File | null;
  tenant: string;
  format: string;
  organization_id?: string;
  project_id?: string;
  operation_id?: string;
  tier?: string;
};
type Result = { summary: ConciergeIngestSummary; selection: Selection };
type Failure = { key: ConciergeMessageKey; detail?: string };
const sameSelection = (a: Selection, b: Selection) =>
  a.file === b.file &&
  a.tenant === b.tenant &&
  a.format === b.format &&
  ['organization_id', 'project_id', 'operation_id', 'tier'].every(
    (key) => a[key as keyof Selection] === b[key as keyof Selection]
  );
const currentLocation = () => {
  const url = new URL(window.location.href);
  return url.pathname + url.search;
};

/** Client input consistency only: the server does not issue a preview token. */
export function useIngestFlow() {
  const [tenants, setTenants] = React.useState<{ tenant_slug: string; display_name: string }[]>([]);
  const [selection, setSelection] = React.useState<Selection>(() => {
    const scope =
      typeof window === 'undefined'
        ? {}
        : workspaceSelectionFromQuery(new URL(window.location.href).searchParams);
    return {
      file: null,
      tenant: scope.tenant_slug || '',
      format: '',
      organization_id: scope.organization_id,
      project_id: scope.project_id,
      operation_id: scope.operation_id,
      tier: scope.tier,
    };
  });
  const selectionRef = React.useRef(selection);
  const selectionLocation = React.useRef(typeof window === 'undefined' ? '' : currentLocation());
  const [dryRun, setDryRun] = React.useState(true);
  const [pending, setPending] = React.useState<'preview' | 'commit' | null>(null);
  const inFlight = React.useRef<'preview' | 'commit' | null>(null);
  const generation = React.useRef(0);
  const ready = React.useRef(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const preview = React.useRef<Result | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [uncertain, setUncertain] = React.useState<Selection | null>(null);
  const uncertainRef = React.useRef<Selection | null>(null);
  const [access, setAccess] = React.useState<401 | 403 | null>(null);
  const accessRef = React.useRef<401 | 403 | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  const clearPreview = React.useCallback(() => {
    preview.current = null;
    setResult(null);
  }, []);
  const markUncertain = React.useCallback((attempt: Selection) => {
    uncertainRef.current = attempt;
    setUncertain(attempt);
    setDryRun(true);
  }, []);

  React.useEffect(() => {
    const current = ++generation.current;
    const location = currentLocation();
    if (selectionLocation.current !== location) {
      const scope = workspaceSelectionFromQuery(new URL(window.location.href).searchParams);
      const next = {
        file: null,
        tenant: scope.tenant_slug || '',
        format: '',
        organization_id: scope.organization_id,
        project_id: scope.project_id,
        operation_id: scope.operation_id,
        tier: scope.tier,
      };
      selectionRef.current = next;
      setSelection(next);
      selectionLocation.current = location;
      clearPreview();
    }
    ready.current = false;
    setLoading(true);
    setLoadError(false);
    void (async () => {
      try {
        const response = await fetch('/api/setup', { cache: 'no-store' });
        if (current !== generation.current) return;
        if (response.status === 401 || response.status === 403) {
          accessRef.current = response.status;
          setAccess(response.status);
          setLoadError(true);
          return;
        }
        const setup = parseSetupResponse(await response.json().catch(() => null));
        if (current !== generation.current) return;
        if (!response.ok || !setup) throw new Error('setup');
        const catalog = setup.tenant.catalog;
        setTenants(catalog);
        const previous = selectionRef.current;
        if (previous.tenant && !catalog.some((item) => item.tenant_slug === previous.tenant))
          throw new Error('Selected workspace is unavailable');
        const tenant =
          previous.project_id && !previous.tenant
            ? ''
            : catalog.some((item) => item.tenant_slug === previous.tenant)
              ? previous.tenant
              : catalog.find((item) => item.tenant_slug === setup.tenant.active_slug)
                  ?.tenant_slug ||
                catalog[0]?.tenant_slug ||
                '';
        const next = { ...previous, tenant };
        selectionRef.current = next;
        setSelection(next);
        ready.current = true;
        accessRef.current = null;
        setAccess(null);
      } catch {
        if (current === generation.current) setLoadError(true);
      } finally {
        if (current === generation.current) setLoading(false);
      }
    })();
    return () => {
      ++generation.current;
      inFlight.current = null;
    };
  }, [reload]);

  React.useEffect(() => {
    const invalidate = () => {
      ++generation.current;
      ready.current = false;
      if (inFlight.current === 'commit') markUncertain(selectionRef.current);
      inFlight.current = null;
      setPending(null);
      clearPreview();
      // BFCache may preserve this component. Recheck access before any next upload.
      setLoading(true);
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('pageshow', restore);
    };
  }, [clearPreview, markUncertain]);

  const changeSelection = (patch: Partial<Selection>) => {
    if (inFlight.current || !ready.current) return;
    const next = {
      ...selectionRef.current,
      ...patch,
      ...(patch.tenant !== undefined && patch.tenant !== selectionRef.current.tenant
        ? { organization_id: undefined, project_id: undefined, operation_id: undefined }
        : {}),
    };
    if (sameSelection(next, selectionRef.current)) return;
    selectionRef.current = next;
    setSelection(next);
    clearPreview();
    setFailure(null);
    // Keep an uncertain attempt visible even when the operator prepares another file.
  };
  const submit = async (asDryRun: boolean, reviewed = false) => {
    if (inFlight.current || !ready.current || accessRef.current) return;
    if (selectionLocation.current !== currentLocation()) {
      ready.current = false;
      clearPreview();
      setReload((value) => value + 1);
      return;
    }
    const snapshot = reviewed ? preview.current?.selection : selectionRef.current;
    if (
      !snapshot?.file ||
      (!snapshot.tenant && !snapshot.project_id) ||
      !sameSelection(snapshot, selectionRef.current)
    )
      return;
    if (!asDryRun && uncertainRef.current) return;
    if (
      reviewed &&
      (preview.current?.summary.outcome !== 'would_commit' || !preview.current.summary.dry_run)
    )
      return;
    const phase = asDryRun ? 'preview' : 'commit';
    inFlight.current = phase;
    setPending(phase);
    clearPreview();
    setFailure(null);
    const current = ++generation.current;
    try {
      const form = new FormData();
      form.set('file', snapshot.file);
      if (snapshot.tenant) form.set('tenant', snapshot.tenant);
      for (const key of ['organization_id', 'project_id', 'operation_id', 'tier'] as const)
        if (snapshot[key]) form.set(key, snapshot[key]);
      if (snapshot.format) form.set('format', snapshot.format);
      if (asDryRun) form.set('dry_run', 'true');
      const response = await fetch('/api/ingest', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(75_000),
      });
      if (selectionLocation.current !== currentLocation()) {
        if (!asDryRun) markUncertain(snapshot);
        ready.current = false;
        clearPreview();
        setLoadError(true);
        return;
      }
      if (current !== generation.current) return;
      if (response.status === 401 || response.status === 403) {
        accessRef.current = response.status;
        setAccess(response.status);
        return;
      }
      const body = await response.json().catch(() => null);
      if (current !== generation.current) return;
      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          setFailure({ key: 'ingest.preview_failed', detail: parseConciergeIngestError(body) });
          setDryRun(true);
          return;
        }
        throw new Error('ingest');
      }
      const parsed = parseConciergeIngestResponse(body, {
        tenant: snapshot.tenant,
        dryRun: asDryRun,
        selection: {
          tenant_slug: snapshot.tenant || undefined,
          organization_id: snapshot.organization_id,
          project_id: snapshot.project_id,
          operation_id: snapshot.operation_id,
          tier: snapshot.tier,
        },
      });
      if (!parsed) throw new Error('ingest');
      const resolved = parsed.summary.selectedWorkspace;
      const reviewed = resolved
        ? {
            ...snapshot,
            tenant: resolved.tenant_slug || '',
            organization_id: resolved.organization_id,
            project_id: resolved.project_id,
            operation_id: resolved.operation_id,
            tier: resolved.tier,
          }
        : snapshot;
      selectionRef.current = reviewed;
      setSelection(reviewed);
      const next = { summary: parsed.summary, selection: reviewed };
      setResult(next);
      if (asDryRun && parsed.summary.outcome === 'would_commit' && !uncertainRef.current)
        preview.current = next;
      if (parsed.summary.outcome === 'committed') {
        const fresh = { ...reviewed, file: null };
        selectionRef.current = fresh;
        setSelection(fresh);
        setDryRun(true);
      }
    } catch {
      if (current !== generation.current) return;
      if (asDryRun) setFailure({ key: 'ingest.preview_failed' });
      else markUncertain(snapshot);
    } finally {
      if (current === generation.current) {
        inFlight.current = null;
        setPending(null);
      }
    }
  };
  return {
    tenants,
    selection,
    dryRun,
    pending,
    result: result?.summary ?? null,
    failure,
    uncertain,
    access,
    loading,
    loadError,
    canConfirm: preview.current !== null && !uncertain && !access,
    changeSelection,
    changeDryRun: (value: boolean) => {
      if (!inFlight.current && !uncertainRef.current) setDryRun(value);
    },
    submit,
    reload: () => {
      if (!inFlight.current) {
        ready.current = false;
        clearPreview();
        setLoading(true);
        setReload((value) => value + 1);
      }
    },
  };
}
