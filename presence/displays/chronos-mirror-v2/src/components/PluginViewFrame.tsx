'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@agent/shared-ui';
import { uxText } from '../lib/ux-vocabulary';
import {
  createPluginViewFrameBroker,
  PLUGIN_VIEW_FRAME_MIN_HEIGHT,
  type PluginViewFrameBroker,
  type PluginViewFrameActionRequest,
  type PluginViewFrameActionResult,
  type PluginViewFrameItem,
} from '../lib/plugin-view-frame-broker';
import type { SupportedLocale } from '../lib/ux-vocabulary';
import { bindConfirmDialogFocus } from '../lib/plugin-view-confirm-focus';

const CONFIRM_ARM_DELAY_MS = 600;

interface PendingConfirm {
  request: PluginViewFrameActionRequest;
  human: boolean;
  resolve: (allowed: boolean) => void;
}

async function submitPluginViewAction(
  request: PluginViewFrameActionRequest
): Promise<PluginViewFrameActionResult> {
  const response = await fetch('/api/headless/a2ui/plugin-views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plugin_id: request.pluginId,
      view_id: request.viewId,
      action_id: request.actionId,
      params: request.params,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    return {
      status: 'error',
      errorCode: typeof record.error === 'string' ? record.error : `HTTP_${response.status}`,
    };
  }
  const data = record.data && typeof record.data === 'object' ? record.data : {};
  const outcome = (data as Record<string, unknown>).outcome;
  const status =
    outcome &&
    typeof outcome === 'object' &&
    typeof (outcome as { status?: unknown }).status === 'string'
      ? (outcome as { status: string }).status
      : 'error';
  return { status };
}

/**
 * PH-02: one sandboxed-iframe plugin view. The frame gets `allow-scripts`
 * only (never same-origin, forms, popups or top navigation), no permissions
 * and no referrer; its document is served by the frame route with a sandbox
 * CSP. Messages go through `createPluginViewFrameBroker`; an action request
 * is shown in a host confirm dialog before the plugin-views POST.
 *
 * The first iframe `load` is the approved document; a later one means the
 * frame navigated itself, so the broker is invalidated, the frame is removed
 * and the user has to reopen the view (a fresh frame and a fresh broker).
 */
export function PluginViewFrame({
  view,
  locale,
  onActionSubmitted,
}: {
  view: PluginViewFrameItem;
  locale: SupportedLocale;
  onActionSubmitted?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(PLUGIN_VIEW_FRAME_MIN_HEIGHT * 2);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [armed, setArmed] = useState(false);
  const [navigated, setNavigated] = useState(false);
  // Bumped on reopen: a new frame element and a new broker.
  const [generation, setGeneration] = useState(0);
  const brokerRef = useRef<PluginViewFrameBroker | null>(null);
  const cancelRef = useRef<HTMLSpanElement | null>(null);
  const onSubmittedRef = useRef(onActionSubmitted);
  onSubmittedRef.current = onActionSubmitted;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  // The broker (and its in-flight / rate-limit state) lives as long as the
  // declared view and its frame element do — not per render, listing reload
  // or locale change.
  const capabilitiesKey = JSON.stringify(view.capabilities);
  const actionsKey = JSON.stringify(view.actions);
  const frameKey = JSON.stringify([view.pluginId, view.viewId, capabilitiesKey, actionsKey]);

  useEffect(() => {
    const actions = JSON.parse(actionsKey) as PluginViewFrameItem['actions'];
    const humanActions = new Set(actions.filter((a) => a.authority === 'human').map((a) => a.id));
    const broker = createPluginViewFrameBroker({
      pluginId: view.pluginId,
      viewId: view.viewId,
      capabilities: JSON.parse(capabilitiesKey) as string[],
      actions,
      locale: localeRef.current,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      // The sandboxed frame has an opaque origin, so '*' is the only target;
      // replies carry codes only.
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, '*'),
      confirm: (request) =>
        new Promise<boolean>((resolve) =>
          setPending({ request, human: humanActions.has(request.actionId), resolve })
        ),
      submit: async (request) => {
        const result = await submitPluginViewAction(request);
        onSubmittedRef.current?.();
        return result;
      },
      onResize: setHeight,
    });
    brokerRef.current = broker;
    const listener = (event: MessageEvent) => {
      broker.handleMessage({ source: event.source, data: event.data });
    };
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      broker.invalidate();
      if (brokerRef.current === broker) brokerRef.current = null;
      setPending((current) => {
        current?.resolve(false);
        return null;
      });
    };
  }, [view.pluginId, view.viewId, capabilitiesKey, actionsKey, generation]);

  useEffect(() => {
    brokerRef.current?.setLocale(locale);
  }, [locale]);

  const onFrameLoad = () => {
    const broker = brokerRef.current;
    if (!broker || broker.frameLoaded()) return;
    setNavigated(true);
    setPending((current) => {
      current?.resolve(false);
      return null;
    });
  };

  const reopen = () => {
    setNavigated(false);
    setGeneration((value) => value + 1);
  };

  // A dialog that opens under the pointer must not take a click aimed
  // elsewhere: Allow is enabled only after a short delay.
  useEffect(() => {
    setArmed(false);
    if (!pending) return undefined;
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const decide = (allowed: boolean) => {
    pending?.resolve(allowed);
    setPending(null);
  };

  // Focus Cancel on open, Escape cancels, focus returns on close.
  const isOpen = pending !== null;
  useEffect(() => {
    if (!isOpen) return undefined;
    return bindConfirmDialogFocus({
      document,
      initial: cancelRef.current?.querySelector('button') ?? null,
      onEscape: () =>
        setPending((current) => {
          current?.resolve(false);
          return null;
        }),
    });
  }, [isOpen]);

  return (
    <section className="kb-section" aria-label={view.title}>
      <header className="kb-section__header">
        <div className="kb-section__heading">
          <h3 className="kb-section__title">{view.title}</h3>
        </div>
      </header>
      {navigated ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
          <p className="kb-section__description">{uxText('view_frame_navigated', locale)}</p>
          <Button
            label={uxText('view_frame_reopen', locale)}
            variant="secondary"
            onClick={reopen}
          />
        </div>
      ) : (
        <iframe
          key={`${frameKey}#${generation}`}
          ref={frameRef}
          onLoad={onFrameLoad}
          src={view.frameUrl}
          title={uxText('view_frame_label', locale)}
          aria-label={uxText('view_frame_label', locale)}
          sandbox="allow-scripts"
          allow=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="w-full"
          style={{
            height,
            border: '1px solid var(--kb-ui-border)',
            borderRadius: 'var(--kb-ui-radius-md)',
          }}
        />
      )}
      {pending ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
          style={{ background: 'color-mix(in srgb, var(--kb-ui-canvas) 72%, transparent)' }}
          role="presentation"
          onClick={() => decide(false)}
        >
          <div
            className="w-full max-w-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-view-frame-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <section className="kb-section" data-tone="accent">
              <header className="kb-section__header">
                <div className="kb-section__heading">
                  <h2 id="plugin-view-frame-confirm-title" className="kb-section__title">
                    {uxText('view_frame_confirm_action', locale)}
                  </h2>
                  {pending.human ? (
                    <p className="kb-section__description">
                      {uxText('view_frame_confirm_human_note', locale)}
                    </p>
                  ) : null}
                </div>
              </header>
              <dl className="kb-kv">
                <dt className="kb-kv__label">{uxText('view_frame_confirm_plugin', locale)}</dt>
                <dd className="kb-kv__value" data-mono="true">
                  {`${pending.request.pluginId} / ${pending.request.viewId}`}
                </dd>
                <dt className="kb-kv__label">{uxText('view_frame_confirm_action_id', locale)}</dt>
                <dd className="kb-kv__value" data-mono="true">
                  {pending.request.actionId}
                </dd>
                <dt className="kb-kv__label">{uxText('view_frame_confirm_params', locale)}</dt>
                <dd className="kb-kv__value" data-mono="true">
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(pending.request.params, null, 2)}
                  </pre>
                </dd>
              </dl>
              <div className="flex flex-wrap justify-end gap-2">
                <span ref={cancelRef}>
                  <Button
                    label={uxText('view_frame_confirm_cancel', locale)}
                    variant="secondary"
                    onClick={() => decide(false)}
                  />
                </span>
                <Button
                  label={uxText('view_frame_confirm_allow', locale)}
                  variant="primary"
                  disabled={!armed}
                  onClick={() => decide(true)}
                />
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </section>
  );
}
