import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseSafeJsonInput } from './foundation/json.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;
}

/** Normalize one JSON event emitted by the native listen-only event source. */
export function parseDesktopEventLine(value: unknown): DesktopEvent | undefined {
  if (!isRecord(value) || typeof value.op !== 'string' || !ALLOWED_EVENTS.has(value.op)) {
    return undefined;
  }

  if (value.op === 'press_key') {
    if (!isRecord(value.params) || Object.keys(value.params).some((key) => key !== 'key_code')) {
      return undefined;
    }
    const keyCode = value.params.key_code;
    if (
      typeof keyCode !== 'number' ||
      !Number.isInteger(keyCode) ||
      keyCode < 0 ||
      keyCode > 65_535
    ) {
      return undefined;
    }
    return { op: 'press_key', params: { key_code: keyCode } };
  }

  if (
    Object.keys(value).some((key) => !['op', 'x', 'y', 'click_count'].includes(key)) ||
    !isFiniteCoordinate(value.x) ||
    !isFiniteCoordinate(value.y)
  ) {
    return undefined;
  }
  const clickCount = value.click_count === undefined ? 1 : value.click_count;
  if (
    typeof clickCount !== 'number' ||
    !Number.isInteger(clickCount) ||
    clickCount < 1 ||
    clickCount > 3
  ) {
    return undefined;
  }
  return {
    op: value.op,
    x: value.x,
    y: value.y,
    click_count: clickCount,
  };
}

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
        const value = parseDesktopEventLine(parseSafeJsonInput(line, 'desktop event'));
        if (value) this.queue.push(value);
      } catch {
        // A malformed helper line is ignored; the feed remains fail-closed.
      }
    }
  }
}

export function createDesktopEventFeed(): DesktopEventFeed {
  return new NativeMacDesktopEventFeed();
}
