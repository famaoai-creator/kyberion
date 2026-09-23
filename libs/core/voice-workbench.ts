/**
 * Voice workbench: replays a timeline of turn-taking inputs through the pure
 * `VoiceTurnTakingMachine` on a fake clock and scores the resulting actions
 * (commits, drops, barge-ins, speculative aborts, EOT latency, TTFA).
 *
 * Honesty contract: a scenario whose `requires` are not all available is
 * always reported as `skipped`, never `pass`.
 */

import * as path from 'node:path';
import { safeReaddir, safeReadFile } from './secure-io.js';
import {
  VoiceTurnTakingMachine,
  type TurnTakingAction,
  type TurnTakingInput,
  type TurnTakingOptions,
} from './voice-turn-taking.js';
import type { VoiceTurnCancelReason } from './voice-turn-cancellation.js';

export type VoiceWorkbenchRequirement = 'streaming_stt' | 'silero_vad' | 'real_tts';

export interface VoiceWorkbenchTimelineEntry {
  at_ms: number;
  /** `at_ms` inside the event is optional; the entry's `at_ms` wins. */
  event: Omit<TurnTakingInput, 'at_ms'> & { at_ms?: number };
}

export interface VoiceWorkbenchExpectation {
  commits?: string[];
  drops?: number;
  hard_stops?: number;
  resumes?: number;
  max_eot_latency_ms?: number;
  cancelled_reasons?: VoiceTurnCancelReason[];
  speculative_aborts?: number;
}

export interface VoiceWorkbenchScenario {
  id: string;
  description?: string;
  requires?: VoiceWorkbenchRequirement[];
  options?: TurnTakingOptions;
  /** Synthetic tick spacing between timeline events. Default 50ms. */
  tick_interval_ms?: number;
  /** Keep ticking this long after the last event so timers can resolve. Default 2000ms. */
  drain_ms?: number;
  timeline: VoiceWorkbenchTimelineEntry[];
  expect: VoiceWorkbenchExpectation;
}

export interface VoiceWorkbenchMetrics {
  eot_latency_ms: number | null;
  false_barge_ins: number;
  ttfa_ms: number | null;
}

export interface VoiceWorkbenchResult {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  skip_reason?: string;
  failures: string[];
  metrics: VoiceWorkbenchMetrics;
  actions: Array<{ at_ms: number; action: TurnTakingAction }>;
}

export interface RunVoiceWorkbenchOptions {
  /** Backends present in this run; unmet `requires` skip the scenario. */
  available?: Set<string>;
}

function emptyMetrics(): VoiceWorkbenchMetrics {
  return { eot_latency_ms: null, false_barge_ins: 0, ttfa_ms: null };
}

function expandTimeline(scenario: VoiceWorkbenchScenario): TurnTakingInput[] {
  const interval = scenario.tick_interval_ms ?? 50;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error(`voice workbench ${scenario.id}: tick_interval_ms must be > 0`);
  }
  const events = [...scenario.timeline]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at_ms - b.entry.at_ms || a.index - b.index)
    .map(({ entry }) => ({ ...entry.event, at_ms: entry.at_ms }) as TurnTakingInput);
  const inputs: TurnTakingInput[] = [];
  let nextTick = interval;
  const tickUntil = (limit: number) => {
    while (nextTick < limit) {
      inputs.push({ type: 'tick', at_ms: nextTick });
      nextTick += interval;
    }
  };
  for (const event of events) {
    tickUntil(event.at_ms);
    inputs.push(event);
  }
  const last = events.length ? events[events.length - 1].at_ms : 0;
  tickUntil(last + (scenario.drain_ms ?? 2_000) + 1);
  return inputs;
}

function sameList<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function runVoiceWorkbenchScenario(
  scenario: VoiceWorkbenchScenario,
  options: RunVoiceWorkbenchOptions = {}
): VoiceWorkbenchResult {
  const available = options.available ?? new Set<string>();
  const missing = (scenario.requires ?? []).filter((requirement) => !available.has(requirement));
  if (missing.length > 0) {
    return {
      id: scenario.id,
      status: 'skipped',
      skip_reason: `missing: ${missing.join(', ')}`,
      failures: [],
      metrics: emptyMetrics(),
      actions: [],
    };
  }

  const machine = new VoiceTurnTakingMachine(scenario.options);
  const actions: VoiceWorkbenchResult['actions'] = [];
  const commits: string[] = [];
  const cancelled: VoiceTurnCancelReason[] = [];
  const eotLatencies: number[] = [];
  let drops = 0;
  let hardStops = 0;
  let resumes = 0;
  let speculativeAborts = 0;
  let lastSilenceAt: number | null = null;
  let firstCommitAt: number | null = null;
  let ttfa: number | null = null;

  for (const input of expandTimeline(scenario)) {
    if (input.type === 'vad_silence') lastSilenceAt = input.at_ms;
    if (input.type === 'tts_start' && firstCommitAt !== null && ttfa === null) {
      ttfa = input.at_ms - firstCommitAt;
    }
    for (const action of machine.step(input)) {
      actions.push({ at_ms: input.at_ms, action });
      switch (action.type) {
        case 'commit':
          commits.push(action.text);
          if (firstCommitAt === null) firstCommitAt = input.at_ms;
          if (lastSilenceAt !== null) eotLatencies.push(input.at_ms - lastSilenceAt);
          break;
        case 'drop':
          drops += 1;
          break;
        case 'hard_stop':
          hardStops += 1;
          cancelled.push('barge_in');
          break;
        case 'resume_tts':
          resumes += 1;
          break;
        case 'abort_speculative':
          speculativeAborts += 1;
          cancelled.push(action.reason);
          break;
        default:
          break;
      }
    }
  }

  const metrics: VoiceWorkbenchMetrics = {
    eot_latency_ms: eotLatencies.length ? Math.max(...eotLatencies) : null,
    false_barge_ins: resumes,
    ttfa_ms: ttfa,
  };
  const expect = scenario.expect;
  const failures: string[] = [];
  if (expect.commits && !sameList(commits, expect.commits)) {
    failures.push(
      `commits: expected ${JSON.stringify(expect.commits)}, got ${JSON.stringify(commits)}`
    );
  }
  const counts: Array<[keyof VoiceWorkbenchExpectation, number]> = [
    ['drops', drops],
    ['hard_stops', hardStops],
    ['resumes', resumes],
    ['speculative_aborts', speculativeAborts],
  ];
  for (const [key, actual] of counts) {
    const expected = expect[key];
    if (expected !== undefined && expected !== actual) {
      failures.push(`${key}: expected ${String(expected)}, got ${actual}`);
    }
  }
  if (expect.cancelled_reasons && !sameList(cancelled, expect.cancelled_reasons)) {
    failures.push(
      `cancelled_reasons: expected ${JSON.stringify(expect.cancelled_reasons)}, got ${JSON.stringify(cancelled)}`
    );
  }
  if (expect.max_eot_latency_ms !== undefined) {
    if (metrics.eot_latency_ms === null) {
      failures.push('max_eot_latency_ms: no committed turn to measure');
    } else if (metrics.eot_latency_ms > expect.max_eot_latency_ms) {
      failures.push(
        `max_eot_latency_ms: expected <= ${expect.max_eot_latency_ms}, got ${metrics.eot_latency_ms}`
      );
    }
  }

  return {
    id: scenario.id,
    status: failures.length ? 'fail' : 'pass',
    failures,
    metrics,
    actions,
  };
}

function assertScenario(value: unknown, source: string): VoiceWorkbenchScenario {
  const scenario = value as Partial<VoiceWorkbenchScenario> | null;
  if (
    !scenario ||
    typeof scenario.id !== 'string' ||
    !Array.isArray(scenario.timeline) ||
    typeof scenario.expect !== 'object' ||
    scenario.expect === null
  ) {
    throw new Error(`invalid voice workbench scenario: ${source}`);
  }
  for (const entry of scenario.timeline) {
    if (!entry || !Number.isFinite(entry.at_ms) || typeof entry.event?.type !== 'string') {
      throw new Error(`invalid voice workbench timeline entry in ${source}`);
    }
  }
  return scenario as VoiceWorkbenchScenario;
}

/** Load every `*.json` scenario in `dir`, sorted by file name. */
export function loadVoiceWorkbenchScenarios(dir: string): VoiceWorkbenchScenario[] {
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      const raw = safeReadFile(file, { encoding: 'utf8' }) as string;
      return assertScenario(JSON.parse(raw), file);
    });
}
