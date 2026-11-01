/**
 * MSN-STORE-BOUNDS-20261101 (P1): size-independent readers for append-only
 * JSONL stores.
 *
 * `readJsonLines` loads the whole file through the 100MB read cap, so a store
 * that outgrows the cap makes every read throw (the trigger-deliveries crash
 * loop). These readers scan the file in fixed chunks through the governed
 * range read instead, so a store's size never makes a read fail. Pick the
 * reader by purpose:
 *
 *  - last record          → {@link readLastJsonLine}
 *  - recent window        → {@link readJsonLinesSince} / {@link readJsonLinesBackward}
 *  - full history         → {@link streamJsonLines} (constant memory)
 *  - append hygiene       → {@link fileEndsWithNewline}
 *
 * I/O goes through the foundation bridge (`getFoundationIo().readRange` =
 * secure-io `safeReadFileRange`, `stat` = `safeStat`) so modules secure-io
 * itself imports (audit-chain) can use these readers without an import cycle.
 * Size caps stay only for untrusted input; there is no total-size cap here —
 * only a per-line guard ({@link DEFAULT_JSONL_MAX_LINE_BYTES}) so one
 * pathological line is never accumulated unbounded.
 */
import { getFoundationIo } from './foundation/io.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';

/** Default chunk size for range reads. */
export const DEFAULT_JSONL_CHUNK_BYTES = 256 * 1024;

/** A single line longer than this is reported/skipped, never accumulated. */
export const DEFAULT_JSONL_MAX_LINE_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

/** Byte access a reader needs. Defaults to the governed foundation bridge. */
export interface JsonlByteSource {
  /** File size in bytes, or undefined when the file does not exist. */
  size(filePath: string): number | undefined;
  /** Up to `length` bytes starting at `position` (fewer at end of file). */
  readRange(filePath: string, position: number, length: number): Buffer;
}

export type JsonlMalformedPolicy =
  'throw' | 'skip' | ((error: unknown, lineNumber: number, rawLine: string) => void);

export interface JsonlScanOptions {
  /** Chunk size for range reads (tests inject small values). */
  chunkBytes?: number;
  /** Per-line guard; longer lines go to `onMalformed` (never accumulated). */
  maxLineBytes?: number;
  /** Byte source override (tests, or modules with their own governed I/O). */
  source?: JsonlByteSource;
}

/** Mirrors `ReadJsonLinesOptions` (minus the whole-file read options). */
export interface JsonlReadOptions<T> extends JsonlScanOptions {
  /**
   * Replay policy for malformed JSON, mapper failures and oversized lines.
   * Default `'throw'`, like `readJsonLines`.
   */
  onMalformed?: JsonlMalformedPolicy;
  /**
   * Optional domain parser. Forward readers pass the one-based line number;
   * backward readers pass the one-based position counted from the end of the
   * file (1 = last line).
   */
  map?: (value: unknown, lineNumber: number, rawLine: string) => T;
}

/** Raised (or passed to `onMalformed`) for a line over `maxLineBytes`. */
export class JsonlLineTooLongError extends Error {
  readonly code = 'JSONL_LINE_TOO_LONG';
  constructor(
    readonly filePath: string,
    readonly limitBytes: number
  ) {
    super(
      `JSONL line exceeds ${limitBytes} bytes in ${filePath} — skipped without buffering | ` +
        'inspect the writer that produced it'
    );
    this.name = 'JsonlLineTooLongError';
  }
}

/** One raw line from a scan; `text` has its `\n` / `\r\n` terminator removed. */
export interface JsonlRawLine {
  text: string;
  /** Forward: one-based line number. Backward: one-based position from the end. */
  lineNumber: number;
  /** False only for a final line with no newline terminator (possibly torn). */
  terminated: boolean;
}

/** An oversized line, reported instead of yielded. */
export interface JsonlOversizedLine {
  lineNumber: number;
  /** First bytes of the line (forward scans only), for diagnostics. */
  prefix: string;
}

const defaultSource: JsonlByteSource = {
  size(filePath) {
    const io = getFoundationIo();
    if (!io.exists(filePath)) return undefined;
    try {
      return io.stat(filePath).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw err;
    }
  },
  readRange(filePath, position, length) {
    const io = getFoundationIo();
    if (!io.readRange) throw new Error('secure_foundation_range_io_not_registered');
    return io.readRange(filePath, position, length);
  },
};

interface ResolvedScan {
  chunk: number;
  maxLine: number;
  source: JsonlByteSource;
}

function resolveScan(options: JsonlScanOptions): ResolvedScan {
  const chunk = options.chunkBytes ?? DEFAULT_JSONL_CHUNK_BYTES;
  const maxLine = options.maxLineBytes ?? DEFAULT_JSONL_MAX_LINE_BYTES;
  if (!Number.isInteger(chunk) || chunk <= 0) throw new Error(`Invalid chunkBytes: ${chunk}`);
  if (!Number.isInteger(maxLine) || maxLine <= 0) {
    throw new Error(`Invalid maxLineBytes: ${maxLine}`);
  }
  return { chunk, maxLine, source: options.source ?? defaultSource };
}

function decodeLine(parts: Buffer[]): string {
  const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** Size of a file, 0 when missing — the raw stat seam for maintenance callers. */
export function jsonlFileSize(filePath: string, options: JsonlScanOptions = {}): number {
  return resolveScan(options).source.size(filePath) ?? 0;
}

/**
 * Forward raw-line scan with constant memory (one chunk plus the current
 * line). Blank lines are yielded too (callers decide). Reads up to the size
 * observed at start, so a concurrent append is not half-read. Oversized lines
 * go to `onOversized` and are skipped.
 */
export function* streamTextLines(
  filePath: string,
  options: JsonlScanOptions & { onOversized?: (line: JsonlOversizedLine) => void } = {}
): Generator<JsonlRawLine> {
  const { chunk, maxLine, source } = resolveScan(options);
  const size = source.size(filePath);
  if (!size) return;
  let parts: Buffer[] = [];
  let partsLen = 0;
  let skipping = false;
  let lineNumber = 0;
  let position = 0;
  while (position < size) {
    const buf = source.readRange(filePath, position, Math.min(chunk, size - position));
    if (buf.length === 0) break;
    position += buf.length;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1) break;
      lineNumber++;
      if (skipping) {
        skipping = false;
      } else if (partsLen + (nl - start) > maxLine) {
        const head = parts[0] ?? buf.subarray(start, nl);
        options.onOversized?.({ lineNumber, prefix: decodeLine([head.subarray(0, 256)]) });
      } else {
        parts.push(buf.subarray(start, nl));
        yield { text: decodeLine(parts), lineNumber, terminated: true };
      }
      parts = [];
      partsLen = 0;
      start = nl + 1;
    }
    if (start < buf.length && !skipping) {
      const rest = buf.subarray(start);
      if (partsLen + rest.length > maxLine) {
        options.onOversized?.({
          lineNumber: lineNumber + 1,
          prefix: decodeLine([(parts[0] ?? rest).subarray(0, 256)]),
        });
        parts = [];
        partsLen = 0;
        skipping = true;
      } else {
        // Copy: the chunk buffer may be reused by a custom source.
        parts.push(Buffer.from(rest));
        partsLen += rest.length;
      }
    }
  }
  if (partsLen > 0 && !skipping) {
    lineNumber++;
    yield { text: decodeLine(parts), lineNumber, terminated: false };
  }
}

/**
 * Backward raw-line scan, newest first. The empty segment after a final
 * newline is not yielded; other blank lines are. Oversized lines go to
 * `onOversized` and are skipped without buffering.
 */
export function* streamTextLinesBackward(
  filePath: string,
  options: JsonlScanOptions & { onOversized?: (line: JsonlOversizedLine) => void } = {}
): Generator<JsonlRawLine> {
  const { chunk, maxLine, source } = resolveScan(options);
  const size = source.size(filePath);
  if (!size) return;
  // `carry` holds the bytes after the current chunk that belong to the line
  // whose start has not been seen yet (in file order).
  let carry: Buffer[] = [];
  let carryLen = 0;
  let skipping = false;
  let first = true; // the segment after the last newline (possibly empty / torn)
  let lineNumber = 0;
  let position = size;

  const emit = function* (tail: Buffer[], isFirst: boolean): Generator<JsonlRawLine | undefined> {
    if (isFirst) {
      const len = tail.reduce((n, b) => n + b.length, 0);
      if (len === 0) return; // file ends with a newline
      lineNumber++;
      yield { text: decodeLine(tail), lineNumber, terminated: false };
      return;
    }
    lineNumber++;
    yield { text: decodeLine(tail), lineNumber, terminated: true };
  };

  while (position > 0) {
    const start = Math.max(0, position - chunk);
    const buf = source.readRange(filePath, start, position - start);
    if (buf.length === 0) break;
    position = start;
    let end = buf.length;
    for (;;) {
      const nl = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      if (nl === -1) break;
      const piece = buf.subarray(nl + 1, end);
      if (skipping) {
        skipping = false;
        lineNumber++;
        options.onOversized?.({ lineNumber, prefix: '' });
        first = false;
      } else if (carryLen + piece.length > maxLine) {
        lineNumber++;
        options.onOversized?.({ lineNumber, prefix: '' });
        first = false;
      } else {
        for (const line of emit([piece, ...carry], first)) if (line) yield line;
        first = false;
      }
      carry = [];
      carryLen = 0;
      end = nl;
    }
    if (end > 0 && !skipping) {
      const rest = buf.subarray(0, end);
      if (carryLen + rest.length > maxLine) {
        carry = [];
        carryLen = 0;
        skipping = true;
      } else {
        carry.unshift(Buffer.from(rest));
        carryLen += rest.length;
      }
    }
  }
  if (skipping) {
    lineNumber++;
    options.onOversized?.({ lineNumber, prefix: '' });
  } else if (carryLen > 0 || !first) {
    for (const line of emit(carry, first)) if (line) yield line;
  }
}

function handleMalformed(
  policy: JsonlMalformedPolicy | undefined,
  error: unknown,
  lineNumber: number,
  rawLine: string
): void {
  if (typeof policy === 'function') {
    policy(error, lineNumber, rawLine);
    return;
  }
  if (policy === 'skip') return;
  throw error;
}

const PARSE_FAILED = Symbol('jsonl-parse-failed');

function parseRecord<T>(
  line: JsonlRawLine,
  options: JsonlReadOptions<T>,
  tolerateTornTail: boolean
): T | typeof PARSE_FAILED {
  let value: unknown;
  try {
    value = parseSafeJsonInput(line.text, `JSONL entry ${line.lineNumber}`);
  } catch (error) {
    // A torn final line (writer died mid-append) is skipped silently by the
    // backward readers; a complete malformed line follows the policy.
    if (tolerateTornTail && !line.terminated) return PARSE_FAILED;
    handleMalformed(options.onMalformed, error, line.lineNumber, line.text);
    return PARSE_FAILED;
  }
  try {
    return options.map ? options.map(value, line.lineNumber, line.text) : (value as T);
  } catch (error) {
    handleMalformed(options.onMalformed, error, line.lineNumber, line.text);
    return PARSE_FAILED;
  }
}

function oversizedHandler<T>(
  filePath: string,
  options: JsonlReadOptions<T>,
  maxLine: number
): (line: JsonlOversizedLine) => void {
  return (line) =>
    handleMalformed(
      options.onMalformed,
      new JsonlLineTooLongError(filePath, maxLine),
      line.lineNumber,
      line.prefix
    );
}

/** Forward generator over parsed records; constant memory regardless of file size. */
export function* streamJsonLines<T = unknown>(
  filePath: string,
  options: JsonlReadOptions<T> = {}
): Generator<T> {
  const { maxLine } = resolveScan(options);
  for (const line of streamTextLines(filePath, {
    ...options,
    onOversized: oversizedHandler(filePath, options, maxLine),
  })) {
    if (!line.text.trim()) continue;
    const record = parseRecord(line, options, false);
    if (record !== PARSE_FAILED) yield record;
  }
}

/** Newest-first generator over parsed records; `break` at your cutoff. */
export function* readJsonLinesBackward<T = unknown>(
  filePath: string,
  options: JsonlReadOptions<T> = {}
): Generator<T> {
  const { maxLine } = resolveScan(options);
  for (const line of streamTextLinesBackward(filePath, {
    ...options,
    onOversized: oversizedHandler(filePath, options, maxLine),
  })) {
    if (!line.text.trim()) continue;
    const record = parseRecord(line, options, true);
    if (record !== PARSE_FAILED) yield record;
  }
}

/** The last complete non-empty record, or null (missing/empty file). */
export function readLastJsonLine<T = unknown>(
  filePath: string,
  options: JsonlReadOptions<T> = {}
): T | null {
  for (const record of readJsonLinesBackward<T>(filePath, options)) return record;
  return null;
}

export interface ReadJsonLinesSinceOptions<T> extends JsonlReadOptions<T> {
  /** Record time in epoch ms; undefined = unknown (the record is kept). */
  timeOf: (record: T) => number | undefined;
  /** Stop at the first record (scanning newest first) older than this. */
  sinceMs: number;
  /** Optional cap on the number of records returned (the newest ones). */
  maxRecords?: number;
}

/**
 * Records newer than `sinceMs`, oldest first. Built from the backward scan;
 * stops at the first record older than `sinceMs` (stores are append-ordered
 * by time), so the cost is proportional to the window, not the file.
 */
export function readJsonLinesSince<T = unknown>(
  filePath: string,
  options: ReadJsonLinesSinceOptions<T>
): T[] {
  const out: T[] = [];
  if (options.maxRecords !== undefined && options.maxRecords <= 0) return out;
  for (const record of readJsonLinesBackward<T>(filePath, options)) {
    const t = options.timeOf(record);
    if (t !== undefined && t < options.sinceMs) break;
    out.push(record);
    if (options.maxRecords !== undefined && out.length >= options.maxRecords) break;
  }
  return out.reverse();
}

/**
 * True when the file ends with `\n`, or is missing/empty (nothing to
 * terminate). Reads the last byte only — an appender uses it to decide
 * whether a torn tail needs a leading newline.
 */
export function fileEndsWithNewline(filePath: string, options: JsonlScanOptions = {}): boolean {
  const { source } = resolveScan(options);
  const size = source.size(filePath);
  if (!size) return true;
  const last = source.readRange(filePath, size - 1, 1);
  return last.length === 0 || last[0] === NEWLINE;
}
