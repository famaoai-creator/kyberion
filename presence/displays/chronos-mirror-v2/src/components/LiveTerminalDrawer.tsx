'use client';

import * as React from 'react';
import { Button, Callout, KeyValue, Section } from '@agent/shared-ui';
import { uxText } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import { parseAgentLogsResponse } from '../lib/agent-logs-response';
import { ChronosInline, ChronosMeta } from './chronos-ui';

type TerminalLine = { ts?: number | string; type?: string; content?: string };

export function LiveTerminalDrawer({
  agentId,
  itemId,
  missionId,
  onClose,
}: {
  agentId: string;
  itemId: string;
  missionId?: string;
  onClose: () => void;
}) {
  const locale = useChronosLocale();
  const [lines, setLines] = React.useState<TerminalLine[]>([]);
  const [prompt, setPrompt] = React.useState('');
  const [following, setFollowing] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const tailRef = React.useRef<HTMLSpanElement>(null);

  const refresh = React.useCallback(async () => {
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logs', agentId, limit: 2000 }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error('terminal log load failed');
    const parsed = parseAgentLogsResponse(payload);
    if (!parsed || parsed.agentId !== agentId) {
      throw new Error('terminal log response was invalid');
    }
    setLines(parsed.logs);
  }, [agentId]);

  React.useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const source =
      typeof window !== 'undefined' && 'EventSource' in window
        ? new EventSource('/api/collaboration/stream')
        : null;
    const onEvent = () => void refresh().catch(() => undefined);
    source?.addEventListener('batch', onEvent);
    source?.addEventListener('notification', onEvent);
    source?.addEventListener('step_begin', onEvent);
    source?.addEventListener('step_end', onEvent);
    return () => source?.close();
  }, [refresh]);

  React.useEffect(() => {
    if (following) tailRef.current?.scrollIntoView({ block: 'end' });
  }, [following, lines]);

  const latestLine = lines[lines.length - 1];
  const progressHint = latestLine?.content || uxText('chronos_terminal_waiting_signal', locale);

  const steer = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ask', agentId, query: prompt.trim(), itemId }),
      });
      if (!response.ok) throw new Error('steering failed');
      setPrompt('');
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const controlMission = async (operation: 'pause' | 'resume') => {
    if (!missionId) {
      setError(uxText('chronos_terminal_no_mission_boundary', locale));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mission_control', missionId, operation }),
      });
      if (!response.ok) throw new Error(`${operation} failed`);
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={uxText('chronos_terminal_title', locale)} headingLevel={3}>
      <div className="chronos-terminal__head">
        <ChronosMeta mono>
          {[
            agentId,
            itemId,
            missionId || `${uxText('chronos_mission', locale)} -`,
            uxText('chronos_terminal_tail_limit', locale),
          ].join(' · ')}
        </ChronosMeta>
        <Button label={uxText('chronos_close', locale)} variant="ghost" onClick={onClose} />
      </div>
      <figure className="kb-code chronos-terminal__log">
        <pre
          className="kb-code__body"
          onScroll={(event) => {
            const target = event.currentTarget;
            setFollowing(target.scrollHeight - target.scrollTop - target.clientHeight < 50);
          }}
        >
          {lines.map((line, index) => (
            <span
              key={`${line.ts || 'line'}-${index}`}
              className="chronos-terminal__line"
              data-stream={line.type === 'stderr' ? 'stderr' : undefined}
            >
              {line.content || ''}
            </span>
          ))}
          <span ref={tailRef} className="chronos-terminal__tail" />
        </pre>
      </figure>
      <KeyValue
        items={[{ label: uxText('chronos_terminal_progress_hint', locale), value: progressHint }]}
      />
      <div className="chronos-terminal__composer">
        <input
          className="kb-input"
          aria-label={uxText('chronos_terminal_steering_placeholder', locale)}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void steer();
          }}
          placeholder={uxText('chronos_terminal_steering_placeholder', locale)}
        />
        <Button
          label={
            busy
              ? uxText('chronos_terminal_sending', locale)
              : uxText('chronos_terminal_send', locale)
          }
          variant="primary"
          disabled={busy || !prompt.trim()}
          onClick={() => void steer()}
        />
      </div>
      <ChronosInline>
        <Button
          label={uxText('chronos_terminal_pause', locale)}
          variant="secondary"
          disabled={busy || !missionId}
          onClick={() => void controlMission('pause')}
        />
        <Button
          label={uxText('chronos_terminal_resume', locale)}
          variant="secondary"
          disabled={busy || !missionId}
          onClick={() => void controlMission('resume')}
        />
        <ChronosMeta>{uxText('chronos_terminal_owner_boundary', locale)}</ChronosMeta>
      </ChronosInline>
      {error ? <Callout tone="danger" title={error} /> : null}
    </Section>
  );
}
