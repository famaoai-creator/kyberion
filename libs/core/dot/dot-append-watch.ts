import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, MAX_RANGE_READ_BYTES, safeReadFileRange } from '../secure-io.js';

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

/** Upper bound on the trigger-detail summary of appended records. */
export const WATCH_APPENDED_DETAIL_MAX_CHARS = 1500;
/** Bytes of the appended tail read to build the summary (newest records win). */
const WATCH_SUMMARY_READ_BYTES = 256 * 1024;
/** Per-field cap for free-text fields (recommendation / context / …). */
const WATCH_SUMMARY_TEXT_CHARS = 200;

/**
 * True when a record ranks below `minSeverity`. A record without a known
 * severity is never below it, so unrated rows still wake the dot.
 */
function belowMinSeverity(record: object, minSeverity: string | undefined): boolean {
  if (!minSeverity || !(minSeverity in SEVERITY_RANK)) return false;
  const severity = String((record as { severity?: unknown }).severity);
  if (!(severity in SEVERITY_RANK)) return false;
  return SEVERITY_RANK[severity] < SEVERITY_RANK[minSeverity];
}

function isSkippedRecord(
  record: unknown,
  ignored: readonly string[],
  minSeverity: string | undefined
): boolean {
  return (
    typeof record === 'object' &&
    record !== null &&
    (ignored.includes(String((record as { kind?: unknown }).kind)) ||
      belowMinSeverity(record, minSeverity))
  );
}

/**
 * Complete, non-blank lines appended in `[fromSize, fromSize + length)`. A
 * trailing unterminated fragment is the next line in progress; it is dropped
 * so it is re-evaluated once complete. `dropLeadingPartial` discards the first
 * line when the window starts mid-record.
 */
function readAppendedLines(
  rel: string,
  fromSize: number,
  length: number,
  rootDir: string | undefined,
  dropLeadingPartial = false
): string[] {
  const safe = assertSafeRepositoryPath(path.join(rootDir ?? pathResolver.rootDir(), rel), {
    allowMissingLeaf: true,
  });
  const tail = safeReadFileRange(safe, fromSize, length).toString('utf8');
  const lines = tail.split('\n');
  if (!tail.endsWith('\n')) lines.pop();
  if (dropLeadingPartial) lines.shift();
  return lines.filter((line) => line.trim().length > 0);
}

/**
 * True when every appended record since the last snapshot is one the charter
 * asked to skip — an ignored `kind`, or a `severity` below `minSeverity`
 * (e.g. the undelivered-notification rows an unwired notify lane keeps
 * producing, or warnings left to the next cron wake), so the watch must not
 * fire. Any blank, malformed or non-skipped line fails open.
 */
export function watchAppendOnlyIgnoredKinds(
  rel: string,
  fromSize: number,
  toSize: number,
  ignored: readonly string[],
  rootDir?: string,
  minSeverity?: string
): boolean {
  const appended = toSize - fromSize;
  if (appended <= 0 || appended > MAX_RANGE_READ_BYTES) return false;
  try {
    const records = readAppendedLines(rel, fromSize, appended, rootDir);
    if (records.length === 0) return true;
    return records.every((line) => {
      try {
        return isSkippedRecord(JSON.parse(line), ignored, minSeverity);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function clip(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ');
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** One appended record compacted to the fields a wake needs to triage it. */
function compactRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const ts = clip(record.timestamp ?? record.ts ?? record.at ?? record.created_at, 40);
  if (ts) parts.push(ts);
  const severity = clip(record.severity, 20);
  if (severity) parts.push(`[${severity}]`);
  const kind = clip(record.kind, 60);
  if (kind) parts.push(`kind=${kind}`);
  const title = clip(record.title ?? record.summary, 160);
  if (title) parts.push(title);
  const dedupe = clip(record.dedupe_key, 120);
  if (dedupe) parts.push(`dedupe_key=${dedupe}`);
  const body = clip(
    record.recommendation ?? record.context ?? record.detail ?? record.message,
    WATCH_SUMMARY_TEXT_CHARS
  );
  if (body) parts.push(`— ${body}`);
  return parts.length > 0 ? parts.join(' ') : (clip(record, WATCH_SUMMARY_TEXT_CHARS) ?? '{}');
}

/**
 * Compact summary of the appended JSONL records a watch wake should act on —
 * the rows {@link watchAppendOnlyIgnoredKinds} would NOT skip — bounded to
 * `maxChars` in total. Reads at most the newest {@link WATCH_SUMMARY_READ_BYTES}
 * of the appended range. Returns `undefined` when nothing can be summarized
 * (unreadable, shrunk/rotated file, or no wake-worthy record).
 */
export function summarizeAppendedJsonlRecords(
  rel: string,
  fromSize: number,
  toSize: number,
  options: {
    ignored?: readonly string[];
    minSeverity?: string;
    rootDir?: string;
    maxChars?: number;
  } = {}
): string | undefined {
  const maxChars = options.maxChars ?? WATCH_APPENDED_DETAIL_MAX_CHARS;
  const appended = toSize - fromSize;
  if (appended <= 0 || maxChars <= 0) return undefined;
  const length = Math.min(appended, WATCH_SUMMARY_READ_BYTES);
  const start = toSize - length;
  let lines: string[];
  try {
    lines = readAppendedLines(rel, start, length, options.rootDir, start > fromSize);
  } catch {
    return undefined;
  }
  const rows: string[] = [];
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    if (isSkippedRecord(record, options.ignored ?? [], options.minSeverity)) continue;
    rows.push(`- ${compactRecord(record as Record<string, unknown>)}`);
  }
  if (rows.length === 0) return undefined;
  // Newest records are the most relevant; keep as many as fit, oldest dropped first.
  const kept: string[] = [];
  let used = 0;
  const omittedLine = (n: number) => `(+${n} earlier record(s) omitted)`;
  const reserve = omittedLine(rows.length).length + 1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const cost = row.length + 1;
    const budget = i === 0 ? maxChars : maxChars - reserve;
    if (used + cost > budget) break;
    kept.unshift(row);
    used += cost;
  }
  if (kept.length === 0) {
    // A single oversized row: hard-truncate the newest one to the cap.
    const newest = rows[rows.length - 1];
    return newest.slice(0, maxChars);
  }
  const omitted = rows.length - kept.length;
  const text = [...(omitted > 0 ? [omittedLine(omitted)] : []), ...kept].join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
