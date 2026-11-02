/**
 * dirty-json — bounded, deterministic repair of LLM-emitted broken JSON.
 *
 * Port of Agent Zero's `helpers/dirty_json.py` tolerant parsing to the
 * candidate-pipeline style of `libs/core/json-repair.ts`. Where `tryRepairJson`
 * stays conservative (it returns null rather than guessing), this module is
 * the more permissive LAST-RESORT stage for LLM output that is *almost* JSON:
 * trailing commas, single-quoted strings, unquoted keys/values, `//` and
 * block comments, `undefined` literals, unterminated strings and missing
 * closing brackets.
 *
 * The pipeline is a fixed sequence of cheap string transforms applied
 * cumulatively, each producing one candidate that is handed to
 * `parseSafeJsonInput` (which also rejects dangerous keys like `__proto__`).
 * The first candidate that parses wins; already-valid input returns on the
 * strict parse before any transform runs. Everything is bounded: the input
 * is size-capped, no stage loops, and nothing is ever `eval`ed.
 */

import { parseSafeJsonInput } from '../foundation/safe-json.js';

/** Hard input ceiling — dirty JSON is for model/file output, not streams. */
export const DIRTY_JSON_MAX_INPUT_CHARS = 1_048_576; // 1 MiB

export type DirtyJsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Stable machine-checkable error codes on the `{ ok: false }` branch. */
export const DIRTY_JSON_ERRORS = Object.freeze({
  EMPTY_INPUT: 'dirty_json_empty_input',
  INPUT_TOO_LARGE: 'dirty_json_input_too_large',
  NO_JSON_BLOCK: 'dirty_json_no_json_block',
  UNREPAIRABLE: 'dirty_json_unrepairable',
} as const);

/**
 * Repair-tolerant JSON parse. `text` is treated as untrusted model/file
 * output; the returned value passed through `parseSafeJsonInput`, so
 * dangerous keys never escape this boundary either.
 */
export function parseDirtyJson(text: string): DirtyJsonParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: DIRTY_JSON_ERRORS.EMPTY_INPUT };
  }
  if (text.length > DIRTY_JSON_MAX_INPUT_CHARS) {
    return { ok: false, error: DIRTY_JSON_ERRORS.INPUT_TOO_LARGE };
  }
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();

  // Fast path: already-valid JSON is returned untouched.
  const strict = tryParse(normalized);
  if (strict.ok) return strict;

  const extracted = extractJsonBlock(normalized);
  if (!extracted) return { ok: false, error: DIRTY_JSON_ERRORS.NO_JSON_BLOCK };

  for (const candidate of buildCandidates(extracted)) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed;
  }
  return { ok: false, error: DIRTY_JSON_ERRORS.UNREPAIRABLE };
}

function tryParse(candidate: string): DirtyJsonParseResult {
  try {
    return { ok: true, value: parseSafeJsonInput(candidate, 'dirty JSON') };
  } catch {
    return { ok: false, error: DIRTY_JSON_ERRORS.UNREPAIRABLE };
  }
}

/**
 * Cumulative normalization — each stage builds on the previous output, so
 * candidates run from least to most invasive.
 */
function buildCandidates(extracted: string): string[] {
  const stages: string[] = [extracted];
  let current = extracted;
  for (const stage of [
    stripJsonComments,
    removeTrailingCommas,
    convertSingleQuotedStrings,
    quoteBareTokens,
    closeUnbalancedConstructs,
  ]) {
    current = stage(current);
    stages.push(current);
  }
  return [...new Set(stages.filter(Boolean))];
}

/** First index of a JSON-ish start: `{`, `[`, `"` or `'` (Agent Zero `get_start_pos`). */
function findJsonStart(input: string): number {
  const indices = ['{', '[', '"', "'"]
    .map((char) => input.indexOf(char))
    .filter((index) => index !== -1);
  return indices.length > 0 ? Math.min(...indices) : -1;
}

/**
 * Slice out the first balanced JSON block, tolerating both quote styles so a
 * `}`/`]` inside a single-quoted string does not end the block early. When
 * the input ends mid-structure (truncated output) the rest of the input is
 * the block — closing it is a later stage's job.
 */
function extractJsonBlock(input: string): string | null {
  const start = findJsonStart(input);
  if (start === -1) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let quote = '';
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      stack.push('}');
      continue;
    }
    if (ch === '[') {
      stack.push(']');
      continue;
    }
    if (ch === '}' || ch === ']') {
      // A closer with no matching opener ends the candidate block.
      if (stack.length === 0 || stack[stack.length - 1] !== ch) {
        return input.slice(start, i + 1).trim();
      }
      stack.pop();
      if (stack.length === 0) return input.slice(start, i + 1).trim();
    }
  }
  return input.slice(start).trim();
}

/** Drop `//` line comments and `/* … *\/` block comments outside strings. */
function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let quote = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = '';
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end === -1 ? input.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Remove commas followed (over whitespace) by `]`/`}` or by end of input. */
function removeTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ',') {
      const rest = input.slice(i + 1);
      if (rest.trim() === '' || /^\s*[\]}]/.test(rest)) continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Convert single-quoted strings to double-quoted JSON strings. Unlike the
 * regex approach in `json-repair.ts`, this tracks the actual string state:
 * an apostrophe inside a double-quoted string (`"it's"`) never opens a
 * single-quoted context. Unterminated single quotes are closed at EOF.
 */
function convertSingleQuotedStrings(input: string): string {
  let out = '';
  let state: 'none' | 'double' | 'single' = 'none';
  let escaped = false;
  for (const ch of input) {
    if (state === 'double') {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') state = 'none';
      continue;
    }
    if (state === 'single') {
      if (escaped) {
        // `\'` inside a single-quoted string is a literal quote; every other
        // escape sequence is preserved for the JSON parser to interpret.
        out += ch === "'" ? "'" : `\\${ch}`;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === "'") {
        state = 'none';
        out += '"';
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      out += ch;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      out += '"';
      continue;
    }
    out += ch;
  }
  if (state === 'single') out += '"';
  return out;
}

const JSON_LITERALS = new Set(['true', 'false', 'null']);
const NULLISH_TOKENS = new Set(['undefined', 'nan', 'infinity', '+infinity', '-infinity']);
const NUMERIC_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BARE_TOKEN_BREAK = /[\s,:[\]{}"'/]/;

/**
 * Quote unquoted tokens — keys and values alike (Agent Zero parses both as
 * bare strings). `true`/`false`/`null` are normalized, `undefined`/`NaN`/
 * `Infinity` become `null`, and numeric tokens pass through untouched.
 * Anything else is emitted as a JSON string literal.
 */
function quoteBareTokens(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (!BARE_TOKEN_BREAK.test(ch)) {
      let end = i;
      while (end < input.length && !BARE_TOKEN_BREAK.test(input[end])) end += 1;
      const token = input.slice(i, end);
      const lower = token.toLowerCase();
      if (JSON_LITERALS.has(lower)) out += lower;
      else if (NULLISH_TOKENS.has(lower)) out += 'null';
      else if (NUMERIC_TOKEN.test(token)) out += token;
      else out += JSON.stringify(token);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Close what truncation left open: an unterminated string gets its quote,
 * a dangling `,` is dropped, a dangling `:` gets a `null` value (Agent Zero
 * assigns `None` to a value the input never supplied), and every unclosed
 * `{`/`[` gets its matching closer in reverse order.
 *
 * A closer that does not match the innermost opener belongs to an outer
 * level (Agent Zero pops the stack without consuming the character): the
 * missing inner closers are emitted first, then the closer pairs with the
 * outer opener it actually matches. A closer with nothing left to pair is
 * stray text and is dropped.
 */
function closeUnbalancedConstructs(input: string): string {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{') {
      stack.push('}');
      out += ch;
      continue;
    }
    if (ch === '[') {
      stack.push(']');
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      while (stack.length > 0 && stack[stack.length - 1] !== ch) out += stack.pop();
      if (stack.length > 0) {
        stack.pop();
        out += ch;
      }
      continue;
    }
    out += ch;
  }
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');
  if (/:\s*$/.test(out)) out += 'null';
  while (stack.length > 0) out += stack.pop();
  return out;
}
