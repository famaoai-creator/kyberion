import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeSpawn } from './secure-io.js';
import type { DesktopObservationSnapshot } from './desktop-recording.js';

type DesktopEvent = NonNullable<DesktopObservationSnapshot['event']>;

export interface DesktopEventFeedStatus {
  event_source: 'native-cg-event-tap' | 'state-observation-only';
  status: 'active' | 'unavailable';
  reason?: string;
}

export interface DesktopEventFeed {
  start(): DesktopEventFeedStatus;
  poll(): DesktopObservationSnapshot['event'] | undefined;
  drain(): DesktopEvent[];
  stop(): void;
  status(): DesktopEventFeedStatus;
}

const ALLOWED_EVENTS = new Set(['click_at', 'right_click_at', 'press_key']);

function fallback(reason: string): DesktopEventFeedStatus {
  return { event_source: 'state-observation-only', status: 'unavailable', reason };
}

export class NativeMacDesktopEventFeed implements DesktopEventFeed {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = '';
  private queue: NonNullable<DesktopObservationSnapshot['event']>[] = [];
  private current: DesktopEventFeedStatus = fallback('event feed has not started');

  start(): DesktopEventFeedStatus {
    this.pending = '';
    this.queue = [];
    if (process.platform !== 'darwin') {
      this.current = fallback(`macos_only_capability:${process.platform}`);
      return this.current;
    }
    const helper = pathResolver.scripts('desktop_event_source.swift');
    if (!safeExistsSync(helper)) {
      this.current = fallback('native desktop event source is missing');
      return this.current;
    }
    try {
      const child = safeSpawn('swift', [helper]);
      this.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => {
        const reason = chunk.toString('utf8').trim();
        if (reason) this.current = fallback(reason);
      });
      child.on('error', (error) => {
        this.current = fallback(`native desktop event source failed: ${error.message}`);
      });
      child.on('exit', (code) => {
        if (code !== 0 && this.current.status === 'active') {
          this.current = fallback(
            `native desktop event source exited with code ${code ?? 'unknown'}`
          );
        }
      });
      this.current = { event_source: 'native-cg-event-tap', status: 'active' };
    } catch (error) {
      this.current = fallback(
        `native desktop event source unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return this.current;
  }

  poll(): DesktopObservationSnapshot['event'] | undefined {
    return this.queue.shift();
  }

  drain(): DesktopEvent[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.pending = '';
    this.queue = [];
  }

  status(): DesktopEventFeedStatus {
    return { ...this.current };
  }

  private consume(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as DesktopObservationSnapshot['event'];
        if (!value || !ALLOWED_EVENTS.has(value.op)) continue;
        this.queue.push(value as NonNullable<DesktopObservationSnapshot['event']>);
      } catch {
        // A malformed helper line is ignored; the feed remains fail-closed.
      }
    }
  }
}

export function createDesktopEventFeed(): DesktopEventFeed {
  return new NativeMacDesktopEventFeed();
}
