/**
 * EV-08: one implementation of "follow an append-only jsonl file".
 *
 * Three consumers had each solved this separately (nerve-bridge's size-delta
 * poll, the collaboration projection's full re-read, the terminal HUD's poll),
 * and the size-delta variants shared a defect: when the file is rotated or
 * truncated, the recorded offset exceeds the real size, `size > lastSize` never
 * holds again, and every subsequent append is lost in silence.
 *
 * The cursor here therefore carries more than an offset. Rotation is detected
 * three ways — size regression, inode change, and a fingerprint of the file's
 * first bytes — because any one of them alone has a blind spot: truncate-then-
 * refill defeats size, some filesystems reuse inodes, and a rotated file can
 * begin with the same bytes.
 *
 * A trailing line without its newline is never consumed. The offset advances
 * only past the last complete record, so a partially-flushed append is read
 * whole on the next pass rather than parsed as a torn fragment and discarded.
 */

import { createHash } from 'node:crypto';
import { parseSafeJsonInput } from './foundation/json.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile, safeStat } from './secure-io.js';
import { createLogger } from './logger.js';

const logger = createLogger('jsonl-tail');

const DEFAULT_FINGERPRINT_BYTES = 256;
const DEFAULT_MAX_SIZE_MB = 16;

export interface JsonlTailCursor {
  /** Bytes consumed; always positioned just past a newline. */
  offset: number;
  /** Hash of the first `fingerprintBytes` bytes, or '' when the file is empty. */
  fingerprint: string;
  /** Inode when the platform reports one, else 0. */
  inode: number;
}

export interface JsonlTailOptions {
  maxSizeMB?: number;
  fingerprintBytes?: number;
  /** Project parsed JSON into a trusted record shape before delivery. */
  parse?: (value: unknown) => unknown;
  /** Called for each line that does not parse. Default: count only. */
  onMalformed?: (line: string, error: unknown) => void;
}

export interface JsonlTailBatch<T> {
  records: T[];
  cursor: JsonlTailCursor;
  /** True when the file was replaced or truncated and reading restarted at 0. */
  rotated: boolean;
  /** Lines that failed to parse in this batch. */
  malformed: number;
}

export const EMPTY_JSONL_CURSOR: Readonly<JsonlTailCursor> = Object.freeze({
  offset: 0,
  fingerprint: '',
  inode: 0,
});

/**
 * Fingerprint a fixed prefix of the file.
 *
 * `basis` is derived from the consumed offset, never from the current file
 * length. Hashing "the first N bytes of whatever is there now" would change on
 * every append to a file shorter than N, which reads as a rotation and rewinds
 * the cursor forever — the fingerprint must cover bytes we have already read,
 * because those cannot change unless the file really was rewritten.
 */
function fingerprintOf(content: Buffer, basis: number): string {
  if (basis <= 0 || content.length === 0) return '';
  return createHash('sha256')
    .update(content.subarray(0, Math.min(basis, content.length)))
    .digest('hex')
    .slice(0, 32);
}

function inodeOf(filePath: string): number {
  try {
    const ino = safeStat(filePath).ino;
    return Number.isFinite(ino) ? Number(ino) : 0;
  } catch {
    return 0;
  }
}

/**
 * Decide whether the file the cursor describes still exists as the same file.
 * Any single positive signal means "restart from the beginning" — losing
 * position is recoverable (records replay), missing a rotation is not.
 */
export function detectRotation(
  cursor: JsonlTailCursor,
  current: { size: number; fingerprint: string; inode: number }
): boolean {
  if (cursor.offset === 0 && !cursor.fingerprint) return false;
  if (current.size < cursor.offset) return true;
  if (cursor.inode !== 0 && current.inode !== 0 && cursor.inode !== current.inode) return true;
  if (cursor.fingerprint && current.fingerprint && cursor.fingerprint !== current.fingerprint) {
    return true;
  }
  return false;
}

/**
 * Split a buffer slice into complete lines plus the byte length consumed.
 * A trailing fragment is left unconsumed.
 */
export function splitCompleteLines(slice: string): { lines: string[]; consumedChars: number } {
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline < 0) return { lines: [], consumedChars: 0 };
  const complete = slice.slice(0, lastNewline + 1);
  return {
    lines: complete.split('\n').filter((line) => line.length > 0),
    consumedChars: lastNewline + 1,
  };
}

export class JsonlTail<T = unknown> {
  private readonly filePath: string;
  private readonly maxSizeMB: number;
  private readonly fingerprintBytes: number;
  private readonly parse: ((value: unknown) => T) | undefined;
  private readonly onMalformed: ((line: string, error: unknown) => void) | undefined;
  private position: JsonlTailCursor;

  constructor(filePath: string, options: JsonlTailOptions = {}) {
    this.filePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    this.maxSizeMB = options.maxSizeMB ?? DEFAULT_MAX_SIZE_MB;
    this.fingerprintBytes = options.fingerprintBytes ?? DEFAULT_FINGERPRINT_BYTES;
    this.parse = options.parse as ((value: unknown) => T) | undefined;
    this.onMalformed = options.onMalformed;
    this.position = { ...EMPTY_JSONL_CURSOR };
  }

  cursor(): JsonlTailCursor {
    return { ...this.position };
  }

  /** Resume from a persisted cursor (or rewind to the start with no argument). */
  seek(cursor: JsonlTailCursor = { ...EMPTY_JSONL_CURSOR }): void {
    this.position = { ...cursor };
  }

  /** Fingerprint basis for a given consumed offset. */
  private basisFor(offset: number): number {
    return Math.min(this.fingerprintBytes, offset);
  }

  /** Skip everything currently in the file; subsequent reads see only new records. */
  seekToEnd(): void {
    if (!safeExistsSync(this.filePath)) {
      this.position = { ...EMPTY_JSONL_CURSOR };
      return;
    }
    const content = safeReadFile(this.filePath, {
      encoding: null,
      maxSizeMB: this.maxSizeMB,
    }) as Buffer;
    this.position = {
      offset: content.length,
      fingerprint: fingerprintOf(content, this.basisFor(content.length)),
      inode: inodeOf(this.filePath),
    };
  }

  /** Read every complete record appended since the last read. */
  read(): JsonlTailBatch<T> {
    if (!safeExistsSync(this.filePath)) {
      // A vanished file is a rotation whose replacement has not appeared yet.
      const rotated = this.position.offset > 0 || Boolean(this.position.fingerprint);
      this.position = { ...EMPTY_JSONL_CURSOR };
      return { records: [], cursor: this.cursor(), rotated, malformed: 0 };
    }

    const content = safeReadFile(this.filePath, {
      encoding: null,
      maxSizeMB: this.maxSizeMB,
    }) as Buffer;
    const inode = inodeOf(this.filePath);
    // Compare over the prefix the cursor already accounted for, so an ordinary
    // append never looks like a replacement.
    const fingerprint = fingerprintOf(content, this.basisFor(this.position.offset));

    const rotated = detectRotation(this.position, {
      size: content.length,
      fingerprint,
      inode,
    });
    if (rotated) {
      logger.warn(
        `[jsonl-tail] ${this.filePath} was rotated or truncated (offset=${this.position.offset} size=${content.length}); restarting from the beginning`
      );
      this.position = { offset: 0, fingerprint: '', inode };
    }

    const slice = content.subarray(this.position.offset).toString('utf8');
    const { lines, consumedChars } = splitCompleteLines(slice);

    const records: T[] = [];
    let malformed = 0;
    for (const line of lines) {
      try {
        const parsed = parseSafeJsonInput(line, 'jsonl tail record');
        records.push(this.parse ? this.parse(parsed) : (parsed as T));
      } catch (err) {
        malformed++;
        // A torn or hand-edited line must not stop the rest of the batch.
        this.onMalformed?.(line, err);
      }
    }

    const nextOffset =
      this.position.offset + Buffer.byteLength(slice.slice(0, consumedChars), 'utf8');
    this.position = {
      offset: nextOffset,
      fingerprint: fingerprintOf(content, this.basisFor(nextOffset)),
      inode,
    };

    return { records, cursor: this.cursor(), rotated, malformed };
  }
}

export function createJsonlTail<T = unknown>(
  filePath: string,
  options: JsonlTailOptions = {}
): JsonlTail<T> {
  return new JsonlTail<T>(filePath, options);
}

export interface SubscribeJsonlOptions extends JsonlTailOptions {
  intervalMs?: number;
  /** Deliver records already in the file. Default false: only new appends. */
  fromBeginning?: boolean;
  signal?: AbortSignal;
  onRotate?: () => void;
}

/**
 * Poll a jsonl file and hand each new record to `onRecord`.
 * Returns an unsubscribe function; the timer is unref'd so it never keeps a
 * process alive on its own.
 */
export function subscribeJsonl<T = unknown>(
  filePath: string,
  onRecord: (record: T) => void,
  options: SubscribeJsonlOptions = {}
): () => void {
  const { intervalMs = 1000, fromBeginning = false, signal, onRotate, ...tailOptions } = options;
  const tail = createJsonlTail<T>(filePath, tailOptions);
  if (!fromBeginning) tail.seekToEnd();

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const batch = tail.read();
      if (batch.rotated) onRotate?.();
      for (const record of batch.records) {
        try {
          onRecord(record);
        } catch (err) {
          // One bad consumer must not stop the subscription.
          logger.warn(
            `[jsonl-tail] listener failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } catch (err) {
      logger.warn(
        `[jsonl-tail] read failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, intervalMs);
  timer.unref?.();

  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
