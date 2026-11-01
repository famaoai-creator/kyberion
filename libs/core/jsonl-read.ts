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
 * I/O goes through the foundation bridge (`getFoundationIo().openRangeReader`
 * = secure-io `openSafeRangeReader`, `stat` = `safeStat`) so modules secure-io
 * itself imports (audit-chain) can use these readers without an import cycle.
 * Each scan holds one descriptor on one inode from start to finish (closed
 * when the generator ends, including an early `break`), so inline rotation or
 * rename-aside compaction of the path cannot tear a scan in progress.
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

/** A reader pinned to one inode for a whole scan; the scan closes it. */
export interface JsonlPinnedReader {
  /** Size when opened; a scan never reads past it. */
  readonly size: number;
  read(position: number, length: number): Buffer;
  close(): void;
}

/** Byte access a reader needs. Defaults to the governed foundation bridge. */
export interface JsonlByteSource {
  /** File size in bytes, or undefined when the file does not exist. */
  size(filePath: string): number | undefined;
  /** Up to `length` bytes starting at `position` (fewer at end of file). */
  readRange(filePath: string, position: number, length: number): Buffer;
  /**
   * Open the file once and read every chunk of a scan from that inode
   * (undefined when missing). Preferred: a rotation or rename-aside
   * compaction of the path mid-scan cannot tear the scan. Without it the scan
   * reads by path, checks size (and {@link identity}) after every chunk, and
   * restarts once if the file changed before anything was emitted.
   */
  open?(filePath: string): JsonlPinnedReader | undefined;
  /** File identity for the by-path fallback (undefined when missing). */
  identity?(filePath: string): { dev: number; ino: number } | undefined;
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

/**
 * The file changed under a by-path scan (replaced, truncated, or a short
 * read) after lines were already emitted, so the scan cannot be restarted
 * without duplicates. Never raised for a pinned ({@link JsonlByteSource.open})
 * scan of an append-only file.
 */
export class JsonlSourceChangedError extends Error {
  readonly code = 'JSONL_SOURCE_CHANGED';
  constructor(
    readonly filePath: string,
    readonly detail: string
  ) {
    super(
      `JSONL file changed during a scan: ${filePath} — ${detail} | ` +
        'retry the read; use a pinned byte source (open) to avoid this'
    );
    this.name = 'JsonlSourceChangedError';
  }
}

/** One raw line from a scan; `text` has its `\n` / `\r\n` terminator removed. */
export interface JsonlRawLine {
  text: string;
  /** Forward: one-based line number. Backward: one-based position from the end. */
  lineNumber: number;
  /** False only for a final line with no newline terminator (possibly torn). */
  terminated: boolean;
  /** Forward scans: byte offset of the line start. */
  byteStart?: number;
  /** Forward scans: byte offset just past the line (after its `\n` when terminated). */
  byteEnd?: number;
}

/** An oversized line, reported instead of yielded. */
export interface JsonlOversizedLine {
  lineNumber: number;
  /** First bytes of the line (forward scans only), for diagnostics. */
  prefix: string;
  /** Forward scans: byte range of the line (end after its `\n` when terminated). */
  byteStart?: number;
  byteEnd?: number;
  /** Forward scans: false when the line runs to the end of the scanned range. */
  terminated?: boolean;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function defaultSource(): JsonlByteSource {
  const io = getFoundationIo();
  const source: JsonlByteSource = {
    size(filePath) {
      if (!io.exists(filePath)) return undefined;
      try {
        return io.stat(filePath).size;
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    },
    readRange(filePath, position, length) {
      if (!io.readRange) throw new Error('secure_foundation_range_io_not_registered');
      return io.readRange(filePath, position, length);
    },
    identity(filePath) {
      try {
        const stat = io.stat(filePath);
        return stat.dev !== undefined && stat.ino !== undefined
          ? { dev: stat.dev, ino: stat.ino }
          : undefined;
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    },
  };
  const openRangeReader = io.openRangeReader;
  if (openRangeReader) {
    source.open = (filePath) => {
      try {
        return openRangeReader.call(io, filePath);
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    };
  }
  return source;
}

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
  return { chunk, maxLine, source: options.source ?? defaultSource() };
}

function decodeLine(parts: Buffer[]): string {
  const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** Size of a file, 0 when missing — the raw stat seam for maintenance callers. */
export function jsonlFileSize(filePath: string, options: JsonlScanOptions = {}): number {
  return resolveScan(options).source.size(filePath) ?? 0;
}

/** One scan's view of a file: a fixed size and exact-length reads. */
interface ScanHandle {
  size: number;
  /** Exactly `length` bytes, or throws {@link JsonlSourceChangedError}. */
  read(position: number, length: number): Buffer;
  close(): void;
}

function openScanHandle(source: JsonlByteSource, filePath: string): ScanHandle | undefined {
  if (source.open) {
    const reader = source.open(filePath);
    if (!reader) return undefined;
    return {
      size: reader.size,
      read(position, length) {
        const buf = reader.read(position, length);
        if (buf.length !== length) {
          throw new JsonlSourceChangedError(filePath, `short read at ${position} (truncated)`);
        }
        return buf;
      },
      close: () => reader.close(),
    };
  }
  // By-path fallback (a reduced adapter): verify the file is still the one
  // the scan started on after every chunk.
  const size = source.size(filePath);
  if (size === undefined) return undefined;
  const identity = source.identity?.(filePath);
  return {
    size,
    read(position, length) {
      let buf: Buffer;
      try {
        buf = source.readRange(filePath, position, length);
      } catch (err) {
        if (isEnoent(err)) throw new JsonlSourceChangedError(filePath, 'file disappeared');
        throw err;
      }
      if (buf.length !== length) {
        throw new JsonlSourceChangedError(filePath, `short read at ${position}`);
      }
      const now = source.size(filePath);
      if (now === undefined || now < size) {
        throw new JsonlSourceChangedError(
          filePath,
          `size went from ${size} to ${now ?? 'missing'}`
        );
      }
      if (identity) {
        const current = source.identity?.(filePath);
        if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new JsonlSourceChangedError(filePath, 'file was replaced');
        }
      }
      return buf;
    },
    close() {},
  };
}

/**
 * Runs one scan on one handle and closes it when the scan ends — including an
 * early `return` / `break` by the consumer. A by-path scan whose file changed
 * before anything was emitted restarts once.
 */
function* pinnedScan<L>(
  filePath: string,
  source: JsonlByteSource,
  run: (handle: ScanHandle, noteEmitted: () => void) => Generator<L>
): Generator<L> {
  for (let attempt = 0; ; attempt++) {
    const handle = openScanHandle(source, filePath);
    if (!handle) return;
    let emitted = false;
    const noteEmitted = (): void => {
      emitted = true;
    };
    try {
      for (const item of run(handle, noteEmitted)) {
        emitted = true;
        yield item;
      }
      return;
    } catch (err) {
      if (!(err instanceof JsonlSourceChangedError) || emitted || attempt >= 1) throw err;
    } finally {
      handle.close();
    }
  }
}

type OversizedSink = (line: JsonlOversizedLine) => void;

export interface StreamTextLinesOptions extends JsonlScanOptions {
  onOversized?: OversizedSink;
  /** Scan at most this many bytes from the start (clamped to the file size). */
  endOffset?: number;
}

/**
 * Forward raw-line scan with constant memory (one chunk plus the current
 * line). Blank lines are yielded too (callers decide). Reads up to the size
 * observed at open, from one pinned inode, so a concurrent append is not
 * half-read and a concurrent rotation does not tear the scan. Oversized
 * lines go to `onOversized` (with their byte range) and are skipped.
 */
export function* streamTextLines(
  filePath: string,
  options: StreamTextLinesOptions = {}
): Generator<JsonlRawLine> {
  const { chunk, maxLine, source } = resolveScan(options);
  yield* pinnedScan(filePath, source, (handle, noteEmitted) =>
    forwardLines(handle, chunk, maxLine, options.endOffset, (line) => {
      noteEmitted();
      options.onOversized?.(line);
    })
  );
}

function* forwardLines(
  handle: ScanHandle,
  chunk: number,
  maxLine: number,
  endOffset: number | undefined,
  onOversized: OversizedSink
): Generator<JsonlRawLine> {
  const limit = endOffset === undefined ? handle.size : Math.min(handle.size, endOffset);
  let parts: Buffer[] = [];
  let partsLen = 0;
  let skipping = false;
  let skipPrefix = '';
  let lineNumber = 0;
  let position = 0;
  let lineStart = 0;
  while (position < limit) {
    const base = position;
    const buf = handle.read(position, Math.min(chunk, limit - position));
    position += buf.length;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1) break;
      lineNumber++;
      const end = base + nl + 1;
      if (skipping) {
        skipping = false;
        onOversized({
          lineNumber,
          prefix: skipPrefix,
          byteStart: lineStart,
          byteEnd: end,
          terminated: true,
        });
      } else if (partsLen + (nl - start) > maxLine) {
        const head = parts[0] ?? buf.subarray(start, nl);
        onOversized({
          lineNumber,
          prefix: decodeLine([head.subarray(0, 256)]),
          byteStart: lineStart,
          byteEnd: end,
          terminated: true,
        });
      } else {
        parts.push(buf.subarray(start, nl));
        yield {
          text: decodeLine(parts),
          lineNumber,
          terminated: true,
          byteStart: lineStart,
          byteEnd: end,
        };
      }
      parts = [];
      partsLen = 0;
      start = nl + 1;
      lineStart = end;
    }
    if (start < buf.length && !skipping) {
      const rest = buf.subarray(start);
      if (partsLen + rest.length > maxLine) {
        skipPrefix = decodeLine([(parts[0] ?? rest).subarray(0, 256)]);
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
  if (skipping) {
    onOversized({
      lineNumber: lineNumber + 1,
      prefix: skipPrefix,
      byteStart: lineStart,
      byteEnd: limit,
      terminated: false,
    });
  } else if (partsLen > 0) {
    lineNumber++;
    yield {
      text: decodeLine(parts),
      lineNumber,
      terminated: false,
      byteStart: lineStart,
      byteEnd: limit,
    };
  }
}

/**
 * Backward raw-line scan, newest first, from one pinned inode. The empty
 * segment after a final newline is not yielded; other blank lines are.
 * Oversized lines go to `onOversized` and are skipped without buffering.
 */
export function* streamTextLinesBackward(
  filePath: string,
  options: JsonlScanOptions & { onOversized?: OversizedSink } = {}
): Generator<JsonlRawLine> {
  const { chunk, maxLine, source } = resolveScan(options);
  yield* pinnedScan(filePath, source, (handle, noteEmitted) =>
    backwardLines(handle, chunk, maxLine, (line) => {
      noteEmitted();
      options.onOversized?.(line);
    })
  );
}

function* backwardLines(
  handle: ScanHandle,
  chunk: number,
  maxLine: number,
  onOversized: OversizedSink
): Generator<JsonlRawLine> {
  // `carry` holds the bytes after the current chunk that belong to the line
  // whose start has not been seen yet (in file order).
  let carry: Buffer[] = [];
  let carryLen = 0;
  let skipping = false;
  let first = true; // the segment after the last newline (possibly empty / torn)
  let lineNumber = 0;
  let position = handle.size;

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
    const buf = handle.read(start, position - start);
    position = start;
    let end = buf.length;
    for (;;) {
      const nl = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      if (nl === -1) break;
      const piece = buf.subarray(nl + 1, end);
      if (skipping) {
        skipping = false;
        lineNumber++;
        onOversized({ lineNumber, prefix: '' });
        first = false;
      } else if (carryLen + piece.length > maxLine) {
        lineNumber++;
        onOversized({ lineNumber, prefix: '' });
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
    onOversized({ lineNumber, prefix: '' });
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
