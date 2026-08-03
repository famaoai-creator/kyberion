'use client';

import * as React from 'react';
import { uxText } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';

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
  const tailRef = React.useRef<HTMLDivElement>(null);

  const refresh = React.useCallback(async () => {
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logs', agentId, limit: 2000 }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'terminal log load failed');
    setLines(payload.logs || []);
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
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'steering failed');
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
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `${operation} failed`);
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border kb-border-accent kb-surface-well p-4">
      <div className="flex items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-accent">
            {uxText('chronos_terminal_title', locale)}
          </div>
          <div className="mt-1 text-[10px] kb-text-muted">
            {agentId} · {itemId} · {missionId || `${uxText('chronos_mission', locale)} -`} · bounded
            tail 2,000 lines
          </div>
        </div>
        <button
          type="button"
          className="ml-auto rounded border kb-border-subtle px-2 py-1 text-[10px] kb-text-secondary"
          onClick={onClose}
        >
          {uxText('chronos_close', locale)}
        </button>
      </div>
      <div
        className="mt-3 max-h-64 overflow-auto rounded-xl border kb-border-subtle bg-black/30 p-3 font-mono text-[10px] kb-text-secondary"
        onScroll={(event) => {
          const target = event.currentTarget;
          setFollowing(target.scrollHeight - target.scrollTop - target.clientHeight < 50);
        }}
      >
        {lines.map((line, index) => (
          <div
            key={`${line.ts || 'line'}-${index}`}
            className={line.type === 'stderr' ? 'kb-status-negative' : ''}
          >
            {line.content || ''}
          </div>
        ))}
        <div ref={tailRef} />
      </div>
      <div className="mt-2 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] kb-text-secondary">
        <span className="font-semibold kb-text-accent">
          {uxText('chronos_terminal_progress_hint', locale)}
        </span>
        <span className="ml-2">{progressHint}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void steer();
          }}
          placeholder={uxText('chronos_terminal_steering_placeholder', locale)}
          className="min-w-0 flex-1 rounded border kb-border-subtle kb-surface-raised px-3 py-2 text-[11px] kb-text-primary"
        />
        <button
          type="button"
          disabled={busy || !prompt.trim()}
          onClick={() => void steer()}
          className="rounded border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] kb-text-accent disabled:opacity-40"
        >
          {busy
            ? uxText('chronos_terminal_sending', locale)
            : uxText('chronos_terminal_send', locale)}
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !missionId}
          onClick={() => void controlMission('pause')}
          className="rounded border kb-border-subtle kb-surface-raised px-2 py-1 text-[10px] kb-text-secondary disabled:opacity-40"
        >
          {uxText('chronos_terminal_pause', locale)}
        </button>
        <button
          type="button"
          disabled={busy || !missionId}
          onClick={() => void controlMission('resume')}
          className="rounded border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] kb-text-accent disabled:opacity-40"
        >
          {uxText('chronos_terminal_resume', locale)}
        </button>
        <span className="self-center text-[9px] kb-text-muted">
          {uxText('chronos_terminal_owner_boundary', locale)}
        </span>
      </div>
      {error ? <div className="mt-2 text-[10px] kb-status-negative">{error}</div> : null}
    </section>
  );
}
