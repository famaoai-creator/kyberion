/**
 * Declarative observation probes (SD-06), pure.
 *
 * An observer that reads an implementation must not carry tenant-specific
 * code into the product. Instead the tenant's case ledger declares *what to
 * look at* as data (`probes.json`: file, regular expression, how to read the
 * capture) and this engine turns those declarations into an
 * {@link DecisionObservedSet} the conformance check consumes. The file reader
 * is injected, so the same engine runs against a checkout under the
 * repository (secure-io) or in an implementation repository's own CI.
 *
 * Capture kinds:
 *   string   the capture group's text
 *   number   Number(capture)
 *   boolean  whether the pattern matched at all
 *   json     JSON.parse(capture)
 *   list     every "…" string literal inside the capture (e.g. an array literal)
 *   count    how many times the pattern matched in the file
 *   exists   whether the file exists
 * `stale_if` marks the observation stale when its pattern matches the file
 * (e.g. a comment that cites a superseded specification revision).
 */
import type { DecisionObservation, DecisionObservedSet } from './model.js';

export type ProbeCapture = 'string' | 'number' | 'boolean' | 'json' | 'list' | 'count' | 'exists';

export interface DecisionProbe {
  key: string;
  file: string;
  pattern: string;
  flags?: string;
  capture?: ProbeCapture;
  group?: number;
  stale_if?: { pattern: string; flags?: string };
  note?: string;
}

export interface DecisionProbeSet {
  version: '1.0.0';
  case_id: string;
  repo: string;
  probes: DecisionProbe[];
  /** How many characters of the matched text to keep as the observation's `quote`. */
  quote_max_chars?: number;
}

export const DEFAULT_PROBE_QUOTE_MAX_CHARS = 200;

export interface ProbeMiss {
  key: string;
  reason: 'file_missing' | 'no_match' | 'bad_json' | 'bad_regex' | 'bad_number';
  file: string;
}

export interface ProbeRunResult {
  observed: DecisionObservedSet;
  misses: ProbeMiss[];
}

export type ProbeFileReader = (relativePath: string) => string | undefined;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function compile(
  pattern: string,
  flags: string | undefined,
  forceGlobal: boolean
): RegExp | undefined {
  try {
    const base = (flags ?? '').replace('g', '');
    return new RegExp(pattern, forceGlobal ? `${base}g` : base);
  } catch {
    return undefined;
  }
}

export function runProbes(
  set: DecisionProbeSet,
  read: ProbeFileReader,
  context: { commit: string; now: string }
): ProbeRunResult {
  const observations: DecisionObservation[] = [];
  const misses: ProbeMiss[] = [];
  const quoteMax = set.quote_max_chars ?? DEFAULT_PROBE_QUOTE_MAX_CHARS;
  for (const probe of set.probes) {
    const text = read(probe.file);
    const capture = probe.capture ?? 'string';
    if (text === undefined) {
      if (capture === 'exists') {
        observations.push({ key: probe.key, value: false, ref: probe.file });
      } else {
        misses.push({ key: probe.key, reason: 'file_missing', file: probe.file });
      }
      continue;
    }
    if (capture === 'exists') {
      observations.push({ key: probe.key, value: true, ref: probe.file });
      continue;
    }
    const regex = compile(probe.pattern, probe.flags, capture === 'count');
    if (!regex) {
      misses.push({ key: probe.key, reason: 'bad_regex', file: probe.file });
      continue;
    }
    if (capture === 'count') {
      const matches = [...text.matchAll(regex)];
      observations.push({
        key: probe.key,
        value: matches.length,
        ref: `${probe.file}:${matches[0] ? lineOf(text, matches[0].index ?? 0) : 0}`,
        ...(matches[0] ? { quote: matches[0][0].slice(0, quoteMax) } : {}),
      });
      continue;
    }
    const match = regex.exec(text);
    if (!match) {
      if (capture === 'boolean') {
        observations.push({ key: probe.key, value: false, ref: probe.file });
      } else {
        misses.push({ key: probe.key, reason: 'no_match', file: probe.file });
      }
      continue;
    }
    const group = match[probe.group ?? (match.length > 1 ? 1 : 0)] ?? match[0];
    let value: unknown;
    if (capture === 'boolean') value = true;
    else if (capture === 'string') value = group.trim();
    else if (capture === 'number') {
      value = Number(group.trim());
      if (Number.isNaN(value)) {
        misses.push({ key: probe.key, reason: 'bad_number', file: probe.file });
        continue;
      }
    } else if (capture === 'json') {
      try {
        value = JSON.parse(group);
      } catch {
        misses.push({ key: probe.key, reason: 'bad_json', file: probe.file });
        continue;
      }
    } else if (capture === 'list') {
      value = [...group.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/gu)].map(
        (item) => item[1] ?? item[2]
      );
    }
    const staleRegex = probe.stale_if
      ? compile(probe.stale_if.pattern, probe.stale_if.flags, false)
      : undefined;
    const stale = staleRegex ? staleRegex.test(text) : false;
    observations.push({
      key: probe.key,
      value,
      ref: `${probe.file}:${lineOf(text, match.index ?? 0)}`,
      quote: match[0].slice(0, quoteMax),
      ...(stale ? { stale: true } : {}),
    });
  }
  return {
    observed: {
      case_id: set.case_id,
      impl: { repo: set.repo, commit: context.commit },
      observed_at: context.now,
      observations,
    },
    misses,
  };
}
