/**
 * Pipeline `{{token}}` template scanning shared by static analysis (the Run
 * Manifest compiler) and the run-manifest admission check. Token rules mirror
 * logic-utils `resolveVars`: a whole-value `{{x}}` keeps the resolved type, a
 * token inside text becomes a substring, and a token never spans a line break.
 */
import { isRecord } from '../foundation/primitives.js';

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const WHOLE_VALUE_TOKEN = /^\{\{([^{}]+)\}\}$/;

export type TemplateSegment = { literal: string } | { token: string };

/** Split a string into literal and `{{token}}` segments exactly as resolveVars scans it. */
export function scanPipelineTemplate(value: string): TemplateSegment[] {
  const whole = value.match(WHOLE_VALUE_TOKEN);
  if (whole) return [{ token: whole[1] }];
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = value.indexOf('{{', searchFrom);
    if (start < 0) break;
    const end = value.indexOf('}}', start + 2);
    if (end < 0) break;
    const token = value.slice(start + 2, end);
    const lineBreak = token.search(LINE_TERMINATOR);
    if (lineBreak >= 0) {
      searchFrom = start + 2 + lineBreak + 1;
      continue;
    }
    if (start > cursor) segments.push({ literal: value.slice(cursor, start) });
    segments.push({ token });
    cursor = end + 2;
    searchFrom = cursor;
  }
  if (cursor < value.length) segments.push({ literal: value.slice(cursor) });
  return segments;
}

export function tokenRootVariable(token: string): string | undefined {
  const name = token.trim();
  if (name.startsWith('@')) return undefined; // repository path token, resolved statically
  const variable = (name.split('|')[0] ?? '').trim();
  return variable.split('.')[0]?.trim() || undefined;
}

export function hasTemplate(value: string): boolean {
  return scanPipelineTemplate(value).some((segment) => 'token' in segment);
}

/**
 * Whether `resolved` is a possible instantiation of the authored `template`:
 * literal parts must survive verbatim and in order; a whole-value token may
 * become any value; a token inside a string may become any substring.
 */
export function pipelineTemplateMatches(template: unknown, resolved: unknown): boolean {
  if (typeof template === 'string') {
    const segments = scanPipelineTemplate(template);
    if (!segments.some((segment) => 'token' in segment)) return resolved === template;
    if (segments.length === 1) return true; // whole-value token preserves any type
    if (typeof resolved !== 'string') return false;
    return literalsMatchInOrder(segments, resolved);
  }
  if (Array.isArray(template)) {
    return (
      Array.isArray(resolved) &&
      resolved.length === template.length &&
      template.every((entry, index) => pipelineTemplateMatches(entry, resolved[index]))
    );
  }
  if (isRecord(template)) {
    if (!isRecord(resolved)) return false;
    const keys = Object.keys(template);
    if (keys.length !== Object.keys(resolved).length) return false;
    return keys.every(
      (key) => Object.hasOwn(resolved, key) && pipelineTemplateMatches(template[key], resolved[key])
    );
  }
  return Object.is(template, resolved);
}

/** Glob match where every token is a `*`: greedy leftmost literal placement is exact. */
function literalsMatchInOrder(segments: TemplateSegment[], value: string): boolean {
  let position = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!('literal' in segment)) continue;
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    if (isFirst) {
      if (!value.startsWith(segment.literal)) return false;
      position = segment.literal.length;
      continue;
    }
    if (isLast) {
      return value.length - segment.literal.length >= position && value.endsWith(segment.literal);
    }
    const found = value.indexOf(segment.literal, position);
    if (found < 0) return false;
    position = found + segment.literal.length;
  }
  return true;
}
