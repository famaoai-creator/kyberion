/**
 * CE-01..12 shared contracts.
 *
 * The claw-empire findings are intentionally adopted as typed, deterministic
 * primitives. UI code consumes these projections; it does not invent a
 * second set of thresholds or retention rules.
 */

import { clamp } from './foundation/text.js';
import { nowIso } from './foundation/time.js';

export const CE_STREAM_LIMITS = Object.freeze({
  maxTailBytes: 16 * 1024,
  maxLiveMessages: 600,
  maxWorkItemLines: 2_000,
  maxSseQueue: 60,
  maxSeenIds: 2_000,
  ttlMapMs: 30 * 60 * 1_000,
});

export const CE_PRESSURE_THRESHOLDS = Object.freeze({
  watch: 0.6,
  elevated: 0.8,
  saturated: 1,
});

export type CePressureSeverity = 'normal' | 'watch' | 'elevated' | 'saturated';

export interface ProviderPressureInput {
  quotaUsed?: number;
  quotaLimit?: number;
  remainingRatio?: number;
  concurrentUsed?: number;
  concurrentLimit?: number;
  demoted?: boolean;
}

export interface ProviderPressure {
  value: number;
  severity: CePressureSeverity;
  demoted: boolean;
}

function finiteRatio(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, 0, 1) : null;
}

/** Normalize quota/concurrency signals into the one UI-facing pressure value. */
export function deriveProviderPressure(input: ProviderPressureInput): ProviderPressure {
  const quota =
    Number.isFinite(input.quotaUsed) &&
    Number.isFinite(input.quotaLimit) &&
    (input.quotaLimit as number) > 0
      ? (input.quotaUsed as number) / (input.quotaLimit as number)
      : input.remainingRatio == null
        ? 0
        : 1 - (finiteRatio(input.remainingRatio) ?? 1);
  const concurrency =
    Number.isFinite(input.concurrentUsed) &&
    Number.isFinite(input.concurrentLimit) &&
    (input.concurrentLimit as number) > 0
      ? (input.concurrentUsed as number) / (input.concurrentLimit as number)
      : 0;
  const value = clamp(Math.max(quota, concurrency, input.demoted ? 1 : 0), 0, 1);
  const severity: CePressureSeverity =
    value >= CE_PRESSURE_THRESHOLDS.saturated
      ? 'saturated'
      : value >= CE_PRESSURE_THRESHOLDS.elevated
        ? 'elevated'
        : value >= CE_PRESSURE_THRESHOLDS.watch
          ? 'watch'
          : 'normal';
  return { value, severity, demoted: input.demoted === true || severity === 'saturated' };
}

/** A bounded FIFO that sheds the oldest item when a surface falls behind. */
export class BoundedRingBuffer<T> {
  private readonly values: T[] = [];

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error('maxSize must be positive');
  }

  push(value: T): void {
    this.values.push(value);
    if (this.values.length > this.maxSize) this.values.splice(0, this.values.length - this.maxSize);
  }

  pushMany(values: Iterable<T>): void {
    for (const value of values) this.push(value);
  }

  toArray(): T[] {
    return [...this.values];
  }

  get size(): number {
    return this.values.length;
  }

  clear(): void {
    this.values.length = 0;
  }
}

/**
 * Consume newline-delimited stream chunks without parsing arbitrary stdout.
 * A marker filter runs before JSON.parse and the incomplete tail is bounded.
 */
export class BoundedLineConsumer<T> {
  private tail = '';
  readonly items: BoundedRingBuffer<T>;

  constructor(
    private readonly parse: (line: string) => T | null,
    private readonly marker?: string,
    maxItems = CE_STREAM_LIMITS.maxLiveMessages,
    private readonly maxTailBytes = CE_STREAM_LIMITS.maxTailBytes
  ) {
    this.items = new BoundedRingBuffer<T>(maxItems);
  }

  consume(chunk: string): T[] {
    this.tail = `${this.tail}${chunk}`;
    if (this.tail.length > this.maxTailBytes) this.tail = this.tail.slice(-this.maxTailBytes);
    const lines = this.tail.split(/\r?\n/u);
    this.tail = lines.pop() || '';
    const parsed: T[] = [];
    for (const line of lines) {
      if (this.marker && !line.includes(this.marker)) continue;
      const item = this.parse(line);
      if (item !== null) {
        parsed.push(item);
        this.items.push(item);
      }
    }
    return parsed;
  }

  flush(): T[] {
    if (!this.tail) return [];
    const line = this.tail;
    this.tail = '';
    if (this.marker && !line.includes(this.marker)) return [];
    const item = this.parse(line);
    if (item === null) return [];
    this.items.push(item);
    return [item];
  }
}

export class TtlLruMap<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs = CE_STREAM_LIMITS.ttlMapMs,
    private readonly maxSize = CE_STREAM_LIMITS.maxSeenIds,
    private readonly now = () => Date.now()
  ) {}

  set(key: K, value: V): void {
    this.prune();
    this.values.delete(key);
    this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.values.size > this.maxSize)
      this.values.delete(this.values.keys().next().value as K);
  }

  get(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.values.delete(key);
  }

  get size(): number {
    this.prune();
    return this.values.size;
  }
}

/** Stable JSON-like equality used by CE-01 to preserve React state identity. */
export function areCeValuesEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => areCeValuesEquivalent(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && areCeValuesEquivalent(leftRecord[key], rightRecord[key])
    )
  );
}

export function retainEquivalent<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && areCeValuesEquivalent(previous, next) ? previous : next;
}

export interface OfficeAgentState {
  agent_id: string;
  status: string;
  title?: string;
  team_role?: string;
  mission_id?: string;
  pressure?: ProviderPressure;
  latest_event?: string;
}

export interface OfficeSnapshot {
  generated_at: string;
  rooms: Array<{ room_id: string; title: string; agents: OfficeAgentState[] }>;
  attention: OfficeAgentState[];
}

/** Data-driven office projection shared by the CLI renderer and Chronos. */
export function composeOfficeSnapshot(input: {
  agents: OfficeAgentState[];
  now?: string;
}): OfficeSnapshot {
  const rooms = new Map<string, { room_id: string; title: string; agents: OfficeAgentState[] }>();
  for (const agent of input.agents) {
    const roomId = agent.mission_id || 'operator-floor';
    const room = rooms.get(roomId) || {
      room_id: roomId,
      title: roomId === 'operator-floor' ? 'Operator floor' : roomId,
      agents: [],
    };
    room.agents.push(agent);
    rooms.set(roomId, room);
  }
  const attention = input.agents.filter((agent) =>
    ['blocked', 'review', 'waiting', 'offline'].includes(agent.status)
  );
  return {
    generated_at: input.now || nowIso(),
    rooms: [...rooms.values()],
    attention,
  };
}

export interface AgentTrackRecord {
  agent_id: string;
  completed_tasks: number;
  reviewed_tasks: number;
  review_pass_rate: number;
  rank: 'unranked' | 'bronze' | 'silver' | 'gold' | 'master';
}

/** Project durable work-item attempts into a small, honest history card. */
export function buildAgentTrackRecords(
  items: Array<{ assignee_peer_id?: string; status: string; attempts?: Array<{ status: string }> }>
): AgentTrackRecord[] {
  const rows = new Map<string, { completed: number; reviewed: number; passed: number }>();
  for (const item of items) {
    const agent = item.assignee_peer_id;
    if (!agent) continue;
    const row = rows.get(agent) || { completed: 0, reviewed: 0, passed: 0 };
    if (item.status === 'done' || item.status === 'archived') row.completed += 1;
    for (const attempt of item.attempts || []) {
      if (attempt.status === 'completed') {
        row.reviewed += 1;
        row.passed += 1;
      }
    }
    rows.set(agent, row);
  }
  return [...rows.entries()]
    .map(([agent_id, row]) => {
      const rate = row.reviewed ? row.passed / row.reviewed : 0;
      const score = row.completed + row.passed;
      const rank: AgentTrackRecord['rank'] =
        score >= 50
          ? 'master'
          : score >= 20
            ? 'gold'
            : score >= 8
              ? 'silver'
              : score >= 1
                ? 'bronze'
                : 'unranked';
      return {
        agent_id,
        completed_tasks: row.completed,
        reviewed_tasks: row.reviewed,
        review_pass_rate: rate,
        rank,
      };
    })
    .sort((a, b) => b.completed_tasks - a.completed_tasks || a.agent_id.localeCompare(b.agent_id));
}

export function isAdvisoryToolUse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'tool_use' ||
    record.type === 'tool_call' ||
    record.tool_use === true ||
    typeof record.tool_name === 'string'
  );
}

export class AdvisoryPolicyViolation extends Error {
  readonly code = 'NO_TOOLS_POLICY_ERROR';
  constructor(message = 'advisory reasoning emitted a tool-use event') {
    super(message);
    this.name = 'AdvisoryPolicyViolation';
  }
}

export function assertAdvisoryEvent(value: unknown, advisory = false): void {
  if (advisory && isAdvisoryToolUse(value)) throw new AdvisoryPolicyViolation();
}

export interface OrphanRunSignals {
  inMemoryAlive?: boolean;
  pidAlive?: boolean;
  recentLog?: boolean;
  logMtime?: number;
  now?: number;
  completedEvidence?: boolean;
}

export function classifyOrphanRun(signals: OrphanRunSignals): 'alive' | 'replay_complete' | 'park' {
  if (signals.inMemoryAlive || signals.pidAlive) return 'alive';
  if (
    signals.completedEvidence ||
    signals.recentLog ||
    (signals.logMtime != null && signals.logMtime >= (signals.now ?? Date.now()) - 30 * 60_000)
  ) {
    return signals.completedEvidence ? 'replay_complete' : 'park';
  }
  return 'park';
}

function hexToRgb(value: string): [number, number, number] {
  const normalized = value.replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => `${c}${c}`)
          .join('')
      : normalized;
  if (!/^[0-9a-f]{6}$/iu.test(expanded)) return [15, 23, 42];
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function blend(
  color: [number, number, number],
  target: [number, number, number],
  amount: number
): [number, number, number] {
  return [0, 1, 2].map((index) => color[index] * (1 - amount) + target[index] * amount) as [
    number,
    number,
    number,
  ];
}

function luminance(color: string): number {
  return hexToRgb(color)
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function readableText(fill: string): string {
  const white = 1.05 / (luminance(fill) + 0.05);
  const dark = (luminance('#0f172a') + 0.05) / 0.05;
  return white >= dark ? '#ffffff' : '#0f172a';
}

export interface CeAccentPalette {
  accent: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
}

/** CE-09: two inputs produce a bounded, readable palette for every surface. */
export function deriveAccentPalette(accent: string, tone = 0.5): CeAccentPalette {
  const clampedTone = clamp(tone, 0, 1);
  const base = hexToRgb(accent);
  const surface = rgbToHex(blend(base, [255, 255, 255], 0.9 - clampedTone * 0.45));
  const surfaceRaised = rgbToHex(blend(base, [255, 255, 255], 0.78 - clampedTone * 0.3));
  const border = rgbToHex(blend(base, [255, 255, 255], 0.35));
  return { accent: rgbToHex(base), surface, surfaceRaised, border, text: readableText(surface) };
}
