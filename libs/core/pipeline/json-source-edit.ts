/**
 * Targeted text edits of a JSON file (`pnpm pipeline fix`,
 * pipeline-run-manifest-model.md §5).
 *
 * Re-serializing a parsed pipeline file would silently change what
 * `JSON.parse` cannot keep — integers beyond 2^53, duplicate keys, the
 * author's formatting. So a fix never round-trips the document: a small
 * scanner records where every value sits in the text, and each change
 * replaces or inserts exactly those characters. Everything else stays byte
 * for byte.
 */

/** A JSON value path: object keys and array indexes from the root. */
export type JsonPath = ReadonlyArray<string | number>;

interface MemberSpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface ValueSpan {
  start: number;
  end: number;
  kind: 'object' | 'array' | 'string' | 'number' | 'literal';
  /** Objects: members in authored order. */
  members?: MemberSpan[];
}

export interface JsonSourceMap {
  text: string;
  /** Keyed by {@link jsonPathKey}. */
  values: Map<string, ValueSpan>;
  /** Paths of objects that repeat a key (`JSON.parse` keeps the last one silently). */
  duplicateKeys: string[];
}

export function jsonPathKey(path: JsonPath): string {
  return JSON.stringify(path);
}

/** Human form: `steps[3].params.script`. */
export function formatJsonPath(path: JsonPath): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`
    )
    .join('');
}

class JsonScanError extends Error {}

/** Scan JSON text into value spans. Throws on text `JSON.parse` would reject. */
export function scanJsonSource(text: string): JsonSourceMap {
  const values = new Map<string, ValueSpan>();
  const duplicateKeys: string[] = [];
  let pos = 0;
  const fail = (what: string): never => {
    throw new JsonScanError(`invalid JSON at offset ${pos}: ${what}`);
  };
  const skipWs = () => {
    while (pos < text.length && /[ \t\r\n]/u.test(text[pos])) pos += 1;
  };
  const scanString = (): string => {
    const start = pos;
    pos += 1;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1;
    if (pos >= text.length) fail('unterminated string');
    pos += 1;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const scanValue = (path: Array<string | number>): void => {
    skipWs();
    const start = pos;
    const ch = text[pos];
    let span: ValueSpan;
    if (ch === '{') {
      pos += 1;
      const members: MemberSpan[] = [];
      const seen = new Set<string>();
      skipWs();
      if (text[pos] === '}') pos += 1;
      else
        for (;;) {
          skipWs();
          if (text[pos] !== '"') fail('expected a key');
          const keyStart = pos;
          const key = scanString();
          if (seen.has(key)) duplicateKeys.push(formatJsonPath([...path, key]));
          seen.add(key);
          skipWs();
          if (text[pos] !== ':') fail('expected ":"');
          pos += 1;
          skipWs();
          const valueStart = pos;
          scanValue([...path, key]);
          members.push({ key, keyStart, valueStart, valueEnd: pos });
          skipWs();
          if (text[pos] === ',') pos += 1;
          else if (text[pos] === '}') {
            pos += 1;
            break;
          } else fail('expected "," or "}"');
        }
      span = { start, end: pos, kind: 'object', members };
    } else if (ch === '[') {
      pos += 1;
      skipWs();
      if (text[pos] === ']') pos += 1;
      else
        for (let index = 0; ; index += 1) {
          scanValue([...path, index]);
          skipWs();
          if (text[pos] === ',') pos += 1;
          else if (text[pos] === ']') {
            pos += 1;
            break;
          } else fail('expected "," or "]"');
        }
      span = { start, end: pos, kind: 'array' };
    } else if (ch === '"') {
      scanString();
      span = { start, end: pos, kind: 'string' };
    } else {
      const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
        text.slice(pos, pos + 400)
      );
      if (!match) fail('unexpected character');
      pos += match![0].length;
      span = { start, end: pos, kind: /^[tfn]/u.test(match![0]) ? 'literal' : 'number' };
    }
    values.set(jsonPathKey(path), span);
  };
  // A byte-order mark is not part of the document.
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  scanValue([]);
  skipWs();
  if (pos !== text.length) fail('trailing characters');
  return { text, values, duplicateKeys };
}

export interface JsonTextEdit {
  start: number;
  end: number;
  text: string;
}

function spanOf(map: JsonSourceMap, path: JsonPath): ValueSpan {
  const span = map.values.get(jsonPathKey(path));
  if (!span) throw new Error(`no value at ${formatJsonPath(path)}`);
  return span;
}

/** Leading whitespace of the line `offset` sits on, when only whitespace precedes it. */
function ownLineIndent(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  return /^[ \t]*$/u.test(before) ? before : undefined;
}

/** Replace the value at `path` with `json` (already-serialized JSON text). */
export function replaceValueEdit(map: JsonSourceMap, path: JsonPath, json: string): JsonTextEdit {
  const span = spanOf(map, path);
  return { start: span.start, end: span.end, text: json };
}

/**
 * Insert `"key": json` into the object at `objectPath`, right after the
 * member `afterKey` (or first when absent), matching the authored layout: a
 * member on its own line gets a new line with the same indentation.
 */
export function insertMemberEdit(
  map: JsonSourceMap,
  objectPath: JsonPath,
  key: string,
  json: string,
  afterKey?: string
): JsonTextEdit {
  const span = spanOf(map, objectPath);
  if (span.kind !== 'object') throw new Error(`${formatJsonPath(objectPath)} is not an object`);
  const members = span.members ?? [];
  if (members.some((member) => member.key === key))
    throw new Error(`${formatJsonPath([...objectPath, key])} already exists`);
  const member = `${JSON.stringify(key)}: ${json}`;
  if (members.length === 0) return { start: span.start, end: span.end, text: `{ ${member} }` };
  const after = afterKey ? members.find((entry) => entry.key === afterKey) : undefined;
  if (after) {
    const indent = ownLineIndent(map.text, after.keyStart);
    return {
      start: after.valueEnd,
      end: after.valueEnd,
      text: indent === undefined ? `, ${member}` : `,\n${indent}${member}`,
    };
  }
  const first = members[0];
  const gap = map.text.slice(span.start + 1, first.keyStart);
  return { start: first.keyStart, end: first.keyStart, text: `${member},${gap || ' '}` };
}

/** Apply non-overlapping edits; throws when two edits overlap. */
export function applyJsonTextEdits(text: string, edits: readonly JsonTextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index += 1)
    if (sorted[index].start < sorted[index - 1].end)
      throw new Error('two fixes edit the same characters');
  let out = '';
  let cursor = 0;
  for (const edit of sorted) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/** Inline JSON for a small string map: `{ "a": "{{a}}", "b": "{{b}}" }`. */
export function inlineJsonObject(value: Record<string, string>): string {
  const entries = Object.entries(value).map(
    ([key, entry]) => `${JSON.stringify(key)}: ${JSON.stringify(entry)}`
  );
  return entries.length ? `{ ${entries.join(', ')} }` : '{}';
}

function shorten(line: string, max: number): string {
  if (line.length <= max) return line;
  const keep = Math.floor((max - 20) / 2);
  return `${line.slice(0, keep)} …(${line.length - 2 * keep} chars)… ${line.slice(-keep)}`;
}

/**
 * A compact unified diff of `edits` applied to `text`: each changed line
 * block with `context` lines around it, long lines shortened for display.
 */
export function unifiedDiffForEdits(
  text: string,
  edits: readonly JsonTextEdit[],
  labels: { from: string; to: string },
  options: { context?: number; maxLineChars?: number } = {}
): string[] {
  const context = options.context ?? 2;
  const max = options.maxLineChars ?? 240;
  const oldLines = text.split('\n');
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length - 1;
  const lineStartOffset = (line: number) =>
    oldLines.slice(0, line).reduce((sum, entry) => sum + entry.length + 1, 0);
  // Edits that touch the same lines form one changed block.
  const groups: Array<{ first: number; last: number; edits: JsonTextEdit[] }> = [];
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const first = lineOf(edit.start);
    const last = lineOf(Math.max(edit.start, edit.end - 1));
    const previous = groups[groups.length - 1];
    if (previous && first <= previous.last) {
      previous.last = Math.max(previous.last, last);
      previous.edits.push(edit);
    } else groups.push({ first, last, edits: [edit] });
  }
  const blocks = groups.map(({ first, last, edits: group }) => {
    const blockStart = lineStartOffset(first);
    const blockEnd = lineStartOffset(last) + oldLines[last].length;
    const shifted = group.map((edit) => ({
      ...edit,
      start: edit.start - blockStart,
      end: edit.end - blockStart,
    }));
    const replaced = applyJsonTextEdits(text.slice(blockStart, blockEnd), shifted);
    return { first, last, added: replaced.split('\n') };
  });
  // Merge blocks that share or touch lines into hunks.
  const hunks: Array<{ first: number; last: number; blocks: typeof blocks }> = [];
  for (const block of blocks) {
    const previous = hunks[hunks.length - 1];
    if (previous && block.first - context <= previous.last + context + 1) {
      previous.last = Math.max(previous.last, block.last);
      previous.blocks.push(block);
    } else hunks.push({ first: block.first, last: block.last, blocks: [block] });
  }
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let delta = 0;
  for (const hunk of hunks) {
    const from = Math.max(0, hunk.first - context);
    const to = Math.min(oldLines.length - 1, hunk.last + context);
    const body: string[] = [];
    let line = from;
    let added = 0;
    for (const block of hunk.blocks) {
      for (; line < block.first; line += 1) body.push(` ${shorten(oldLines[line], max)}`);
      for (; line <= block.last; line += 1) body.push(`-${shorten(oldLines[line], max)}`);
      for (const entry of block.added) body.push(`+${shorten(entry, max)}`);
      added += block.added.length - (block.last - block.first + 1);
    }
    for (; line <= to; line += 1) body.push(` ${shorten(oldLines[line], max)}`);
    const oldCount = to - from + 1;
    out.push(`@@ -${from + 1},${oldCount} +${from + 1 + delta},${oldCount + added} @@`, ...body);
    delta += added;
  }
  return out;
}
