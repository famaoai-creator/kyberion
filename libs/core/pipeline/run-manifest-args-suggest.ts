/**
 * `pnpm pipeline check` help for templated page scripts
 * (pipeline-run-manifest-model §5).
 *
 * A `browser:evaluate` whose `script` splices pipeline templates
 * (`'{{target}}'`, `{{last_id}}`) is unbindable (`templated_script`): page
 * data spliced into approved code is code injection. The author's fix is
 * mechanical — make the script a page function `(a) => …`, read each value
 * from `a.<name>` and pass `"args": {"<name>": "{{<name>}}"}` (the browser
 * actuator hands args over as data). This module proposes that rewrite for
 * the shapes it can transform without changing what the script does, and
 * declines (with a reason) everything else. It never compiles or runs the
 * script; a small lexer tells code, strings, template literals, regular
 * expressions and comments apart.
 *
 * Equivalence (for the values the template would splice): a token that is a
 * whole string literal `'{{x}}'` becomes `String(a.x)` and a token inside a
 * longer literal `'id-{{x}}'` becomes `('id-' + String(a.x))` — identical for
 * scalar values (string, number, boolean, null); an object spliced into text
 * is JSON, so object-valued tokens differ (rare in page scripts). An unset
 * variable is spliced as "" by the resolver and also arrives in args as "" (a
 * whole-value template with no value resolves to the empty string, never
 * `undefined`), so string sites stay identical.
 *
 * A bare token used as a value `{{x}}` becomes `a.x`, and that is NOT
 * identical in general: the old script parsed the spliced TEXT as code, the
 * new one receives the context VALUE as data. A context string "42" used to
 * become the number 42 and now stays the string "42"; a string spliced as
 * code was an injection and now arrives as data; an unset variable used to
 * leave a syntax error and now arrives as "". Only a value that already has
 * the JSON type the code expects (a real number, boolean, array or object in
 * the context) behaves the same. Every suggestion is printed with that caveat.
 *
 * Credentials are never moved into args: a `{{env.X}}` token or a variable a
 * `secret:get` step exports would hand a credential to page code as data, so
 * the rewrite declines it with a reason.
 */
import { isRecord } from '../foundation/primitives.js';
import { scanPipelineTemplate } from './pipeline-template.js';
import {
  credentialTokenRef,
  MAX_PRESENTABLE_SCRIPT_CHARS,
  secretExportVariables,
} from './run-manifest.js';

export type ArgsSuggestion =
  | {
      ok: true;
      /** The rewritten page function source. */
      script: string;
      /** Arg name → whole-value pipeline template the runner resolves. */
      args: Record<string, string>;
      /** Set when the rewrite is still too long for the approval card. */
      note?: string;
    }
  | { ok: false; reason: string };

class Decline extends Error {}

function decline(reason: string): never {
  throw new Decline(reason);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type LexKind = 'punct' | 'ident' | 'number' | 'string' | 'template' | 'regex' | 'ptoken';

interface TemplateSite {
  start: number;
  end: number;
  token: string;
}

interface LexToken {
  kind: LexKind;
  value: string;
  start: number;
  end: number;
  /** A line break precedes this token. */
  newlineBefore: boolean;
  /** `string` tokens: the pipeline templates inside it. */
  sites?: TemplateSite[];
  /** `ptoken`: the template token text. */
  token?: string;
  /** `)` closing an `if`/`while`/`for`/`with` header: a `/` after it is a regex. */
  regexAfter?: boolean;
}

/** Words after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
/** Keywords whose `(…)` header is followed by a statement (a `/` there is a regex). */
const STATEMENT_HEADER_WORDS = new Set(['if', 'while', 'for', 'with']);

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$]/u;
const LINE_BREAK = /[\n\r\p{Zl}\p{Zp}]/u;

function templateSites(source: string): TemplateSite[] {
  const sites: TemplateSite[] = [];
  let offset = 0;
  for (const segment of scanPipelineTemplate(source)) {
    if ('literal' in segment) {
      offset += segment.literal.length;
    } else {
      const length = segment.token.length + 4;
      sites.push({ start: offset, end: offset + length, token: segment.token });
      offset += length;
    }
  }
  return sites;
}

function lex(source: string): LexToken[] {
  const sites = templateSites(source);
  const siteAt = new Map(sites.map((site) => [site.start, site]));
  const tokens: LexToken[] = [];
  // Open brackets: the significant token before each `(` decides what `)` ends.
  const brackets: Array<{ char: string; before: LexToken | undefined }> = [];
  // Template literals: brace depth of the `${` code each one is inside.
  const templates: number[] = [];
  let newline = false;
  let i = 0;

  const push = (kind: LexKind, start: number, end: number, extra: Partial<LexToken> = {}) => {
    tokens.push({
      kind,
      value: source.slice(start, end),
      start,
      end,
      newlineBefore: newline,
      ...extra,
    });
    newline = false;
  };
  /** Skip a region that must not contain a template; returns its end. */
  const quiet = (start: number, end: number, what: string) => {
    if (sites.some((site) => site.start < end && site.end > start))
      decline(`a template sits inside ${what}`);
    return end;
  };
  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.kind === 'ident') return REGEX_AFTER_WORDS.has(prev.value);
    // A template-literal chunk ending in `${` opens an expression.
    if (prev.kind === 'template') return prev.value.endsWith('${');
    if (prev.kind !== 'punct') return false;
    if (prev.value === ']') return false;
    if (prev.value === ')') return prev.regexAfter === true;
    if (prev.value === '}') decline('a `/` after `}` could be a division or a regular expression');
    if (
      (prev.value === '+' || prev.value === '-') &&
      tokens[tokens.length - 2]?.value === prev.value
    )
      decline('a `/` after `++`/`--` could be a division or a regular expression');
    return true;
  };

  while (i < source.length) {
    const site = siteAt.get(i);
    if (site) {
      if (templates.length) decline('a template sits inside a JavaScript template literal');
      push('ptoken', site.start, site.end, { token: site.token });
      i = site.end;
      continue;
    }
    const char = source[i];
    if (/\s/u.test(char)) {
      if (LINE_BREAK.test(char)) newline = true;
      i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      let end = i + 2;
      while (end < source.length && !LINE_BREAK.test(source[end])) end += 1;
      i = quiet(i, end, 'a comment');
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) decline('unterminated comment');
      if (LINE_BREAK.test(source.slice(i, close))) newline = true;
      i = quiet(i, close + 2, 'a comment');
      continue;
    }
    if (char === '/' && regexAllowed()) {
      let end = i + 1;
      let inClass = false;
      for (;;) {
        const next = source[end];
        if (next === undefined || LINE_BREAK.test(next)) decline('unterminated regular expression');
        if (next === '\\') end += 2;
        else {
          end += 1;
          if (next === '[') inClass = true;
          else if (next === ']') inClass = false;
          else if (next === '/' && !inClass) break;
        }
      }
      while (end < source.length && ID_PART.test(source[end])) end += 1;
      quiet(i, end, 'a regular expression');
      push('regex', i, end);
      i = end;
      continue;
    }
    if (char === "'" || char === '"') {
      const inner: TemplateSite[] = [];
      let end = i + 1;
      for (;;) {
        const inside = siteAt.get(end);
        if (inside) {
          inner.push(inside);
          end = inside.end;
          continue;
        }
        const next = source[end];
        if (next === undefined) decline('unterminated string literal');
        if (next === '\\') {
          if (siteAt.has(end + 1))
            decline('a template follows an escape character in a string literal');
          end += 2;
          continue;
        }
        if (LINE_BREAK.test(next)) decline('unterminated string literal');
        end += 1;
        if (next === char) break;
      }
      if (templates.length && inner.length)
        decline('a template sits inside a JavaScript template literal');
      push('string', i, end, inner.length ? { sites: inner } : {});
      i = end;
      continue;
    }
    if (
      char === '`' ||
      (char === '}' && templates.length && templates[templates.length - 1] === 0)
    ) {
      // A template literal chunk: from ` or the `}` closing `${` up to ` or `${`.
      const opening = char === '`';
      if (!opening) templates.pop();
      let end = i + 1;
      for (;;) {
        const next = source[end];
        if (next === undefined) decline('unterminated template literal');
        if (next === '\\') {
          end += 2;
          continue;
        }
        if (next === '`') {
          end += 1;
          break;
        }
        if (next === '$' && source[end + 1] === '{') {
          end += 2;
          templates.push(0);
          break;
        }
        end += 1;
      }
      quiet(i, end, 'a JavaScript template literal');
      // Each chunk (` … ${ or } … `) is its own token; only its kind matters.
      push('template', i, end);
      i = end;
      continue;
    }
    if (ID_START.test(char)) {
      let end = i + 1;
      while (end < source.length && ID_PART.test(source[end])) end += 1;
      push('ident', i, end);
      i = end;
      continue;
    }
    if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(source[i + 1] ?? ''))) {
      let end = i + 1;
      while (end < source.length) {
        const next = source[end];
        if (/[\w.]/u.test(next)) end += 1;
        else if ((next === '+' || next === '-') && /[eE]/u.test(source[end - 1])) end += 1;
        else break;
      }
      push('number', i, end);
      i = end;
      continue;
    }
    // Punctuation: only `=>`, `?.` and `...` need to stay whole.
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const width = three === '...' ? 3 : two === '=>' || two === '?.' ? 2 : 1;
    const value = source.slice(i, i + width);
    if (value === '(' || value === '[' || value === '{') {
      brackets.push({ char: value, before: tokens[tokens.length - 1] });
      if (value === '{' && templates.length) templates[templates.length - 1] += 1;
    } else if (value === ')' || value === ']' || value === '}') {
      const open = brackets.pop();
      const expected = value === ')' ? '(' : value === ']' ? '[' : '{';
      if (!open || open.char !== expected) decline('unbalanced brackets');
      if (value === '}' && templates.length) templates[templates.length - 1] -= 1;
      push('punct', i, i + width);
      if (
        value === ')' &&
        open.before?.kind === 'ident' &&
        STATEMENT_HEADER_WORDS.has(open.before.value)
      )
        tokens[tokens.length - 1].regexAfter = true;
      i += width;
      continue;
    }
    push('punct', i, i + width);
    i += width;
  }
  if (brackets.length) decline('unbalanced brackets');
  if (templates.length) decline('unterminated template literal');
  return tokens;
}

/** Index of the bracket that closes the one at `open`. */
function matchingIndex(tokens: readonly LexToken[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'punct') continue;
    if (token.value in pairs) depth += 1;
    else if (Object.values(pairs).includes(token.value)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Tokens of [from, to) that sit at bracket depth 0 relative to `from`. */
function topLevel(tokens: readonly LexToken[], from: number, to: number): LexToken[] {
  const out: LexToken[] = [];
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (token.kind === 'punct' && ['(', '[', '{'].includes(token.value)) {
      if (depth === 0) out.push(token);
      depth += 1;
    } else if (token.kind === 'punct' && [')', ']', '}'].includes(token.value)) {
      depth -= 1;
      if (depth === 0) out.push(token);
    } else if (depth === 0) out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

/** `name`, `a.b`, `items[0]`, `env.X`; string sites may add `|default`. */
const TOKEN_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/u;

interface ParsedToken {
  /** The whole-value template the args entry carries. */
  template: string;
  /** Variable path (before any `|default`). */
  path: string;
}

/** Variable → secret reference of the credentials the script must not receive as args. */
type CredentialVariables = ReadonlyMap<string, string>;

function parseToken(
  raw: string,
  allowDefault: boolean,
  credentials: CredentialVariables
): ParsedToken {
  const token = raw.trim();
  if (token.startsWith('@')) decline(`{{${token}}} is a repository path token`);
  const credential = credentialTokenRef(token, credentials);
  if (credential)
    decline(
      `{{${token}}} carries a credential (${credential}); a page script must not receive it as args`
    );
  const bar = token.indexOf('|');
  const path = (bar < 0 ? token : token.slice(0, bar)).trim();
  if (bar >= 0 && !allowDefault)
    decline(`{{${token}}} has a default outside a string literal (its type would change)`);
  if (!TOKEN_PATH.test(path)) decline(`{{${token}}} is not a plain variable path`);
  return { template: `{{${token}}}`, path };
}

function sanitizeArgName(path: string): string {
  const name = path
    .replace(/[^\w$]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .replace(/^(\d)/u, '_$1');
  return name || 'value';
}

const PARAM_CANDIDATES = ['a', 'args', '__args', '__pipelineArgs'];

/** Rewrite one templated page script into `(a) => …` plus args, or decline. */
export function suggestScriptArgsRewrite(
  script: string,
  options: { secretVariables?: Iterable<string> } = {}
): ArgsSuggestion {
  try {
    return rewrite(
      script,
      new Map([...(options.secretVariables ?? [])].map((name) => [name, `secret:${name}`]))
    );
  } catch (error) {
    if (error instanceof Decline) return { ok: false, reason: error.message };
    throw error;
  }
}

function rewrite(script: string, credentials: CredentialVariables): ArgsSuggestion {
  if (!templateSites(script).length) decline('the script has no pipeline template');
  const tokens = lex(script);
  const placed = tokens.reduce(
    (count, token) => count + (token.kind === 'ptoken' ? 1 : (token.sites?.length ?? 0)),
    0
  );
  if (placed !== templateSites(script).length)
    decline('a template could not be placed in code or a string literal');
  // Trailing `;` are not part of the expression.
  let last = tokens.length;
  while (last > 0 && tokens[last - 1].kind === 'punct' && tokens[last - 1].value === ';') last -= 1;
  if (last === 0) decline('empty script');

  const idents = new Set(tokens.filter((token) => token.kind === 'ident').map((t) => t.value));
  for (const word of ['this', 'arguments'])
    if (idents.has(word))
      decline(`the script uses \`${word}\`, which a page function binds differently`);
  const param = PARAM_CANDIDATES.find((name) => !idents.has(name));
  if (!param) decline('no free parameter name');

  // Shape: which token range is the body, and how it is wrapped.
  const shape = scriptShape(tokens, last);

  // Arg names: one per distinct template text, sanitized, collision-free.
  const args: Record<string, string> = {};
  const nameOf = new Map<string, string>();
  const argFor = (parsed: ParsedToken): string => {
    const known = nameOf.get(parsed.template);
    if (known) return known;
    const base = sanitizeArgName(parsed.path);
    let name = base;
    for (let n = 2; Object.hasOwn(args, name); n += 1) name = `${base}_${n}`;
    args[name] = parsed.template;
    nameOf.set(parsed.template, name);
    return name;
  };

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (let index = shape.from; index < shape.to; index += 1) {
    const token = tokens[index];
    const prev = tokens[index - 1];
    const next = tokens[index + 1];
    const objectKey =
      prev?.kind === 'punct' &&
      (prev.value === '{' || prev.value === ',') &&
      next?.kind === 'punct' &&
      next.value === ':';
    if (token.kind === 'ptoken') {
      const parsed = parseToken(token.token ?? '', false, credentials);
      if (objectKey) decline(`{{${parsed.path}}} is used as an object key`);
      // A value position: after an operator / opening bracket / operator
      // keyword (`return`, `typeof`), and followed by punctuation.
      const valueAfter =
        prev === undefined ||
        (prev.kind === 'punct' && prev.value !== '.' && prev.value !== '?.') ||
        (prev.kind === 'ident' && REGEX_AFTER_WORDS.has(prev.value) && prev.end < token.start);
      if (!valueAfter || (next !== undefined && next.kind !== 'punct'))
        decline(`{{${parsed.path}}} is spliced into a longer token`);
      replacements.push({
        start: token.start,
        end: token.end,
        text: `${param}.${argFor(parsed)}`,
      });
    } else if (token.sites) {
      if (objectKey) decline('a templated string is used as an object key');
      const quote = token.value[0];
      const parts: string[] = [];
      let cursor = token.start + 1;
      const literal = (from: number, to: number) => {
        if (to <= from) return;
        const raw = script.slice(from, to);
        const trailing = raw.match(/\\+$/u)?.[0].length ?? 0;
        if (trailing % 2 === 1)
          decline('a template follows an escape character in a string literal');
        parts.push(`${quote}${raw}${quote}`);
      };
      for (const site of token.sites) {
        literal(cursor, site.start);
        parts.push(`String(${param}.${argFor(parseToken(site.token, true, credentials))})`);
        cursor = site.end;
      }
      literal(cursor, token.end - 1);
      replacements.push({
        start: token.start,
        end: token.end,
        text: parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`,
      });
    }
  }
  // Templates outside the body (in the wrapper) cannot be rewritten.
  const outside = tokens.some(
    (token, index) =>
      (index < shape.from || index >= shape.to) && (token.kind === 'ptoken' || token.sites)
  );
  if (outside) decline('a template sits outside the script body');

  // A block body keeps its text between the braces verbatim (whitespace too).
  let body = '';
  let cursor = shape.kind === 'block' ? tokens[shape.from - 1].end : tokens[shape.from].start;
  const bodyEnd = shape.kind === 'block' ? tokens[shape.to].start : tokens[shape.to - 1].end;
  for (const replacement of replacements) {
    body += script.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  body += script.slice(cursor, bodyEnd);
  const head = `${shape.async ? 'async ' : ''}(${param}) => `;
  const rewritten =
    shape.kind === 'block'
      ? `${head}{${body}}`
      : shape.kind === 'arrow'
        ? `${head}${body}`
        : `${head}(${body})`;
  return {
    ok: true,
    script: rewritten,
    args,
    ...(rewritten.length > MAX_PRESENTABLE_SCRIPT_CHARS
      ? {
          note: `the rewritten script is longer than ${MAX_PRESENTABLE_SCRIPT_CHARS} characters, so it still asks per step (script_not_presentable)`,
        }
      : {}),
  };
}

interface ScriptShape {
  /** Body token range [from, to). */
  from: number;
  to: number;
  async: boolean;
  /** block: `{…}` statements; arrow: an arrow body kept verbatim; expression: wrapped in parens. */
  kind: 'block' | 'arrow' | 'expression';
}

const STATEMENT_START = new Set([
  'const',
  'let',
  'var',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'throw',
  'return',
  'function',
  'class',
  'async',
  'import',
  'export',
  'break',
  'continue',
]);

function isPunct(token: LexToken | undefined, value: string): boolean {
  return token?.kind === 'punct' && token.value === value;
}

function scriptShape(tokens: readonly LexToken[], last: number): ScriptShape {
  const iife =
    last >= 4 &&
    isPunct(tokens[0], '(') &&
    isPunct(tokens[last - 2], '(') &&
    isPunct(tokens[last - 1], ')') &&
    isPunct(tokens[last - 3], ')') &&
    matchingIndex(tokens, 0) === last - 3;
  if (iife) {
    let index = 1;
    const isAsync = tokens[index]?.kind === 'ident' && tokens[index].value === 'async';
    if (isAsync) index += 1;
    const close = last - 3; // the `)` closing the wrapper
    // `(() => BODY)()`
    if (
      isPunct(tokens[index], '(') &&
      isPunct(tokens[index + 1], ')') &&
      isPunct(tokens[index + 2], '=>')
    ) {
      const from = index + 3;
      if (from >= close) decline('empty arrow body');
      if (isPunct(tokens[from], '{')) {
        if (matchingIndex(tokens, from) !== close - 1)
          decline('unknown wrapper: the arrow body continues after its block');
        return { from: from + 1, to: close - 1, async: isAsync, kind: 'block' };
      }
      if (topLevel(tokens, from, close).some((token) => isPunct(token, ',')))
        decline('unknown wrapper: a comma follows the arrow function');
      return { from, to: close, async: isAsync, kind: 'arrow' };
    }
    // `(function () { BODY })()`
    if (
      tokens[index]?.kind === 'ident' &&
      tokens[index].value === 'function' &&
      isPunct(tokens[index + 1], '(') &&
      isPunct(tokens[index + 2], ')') &&
      isPunct(tokens[index + 3], '{') &&
      matchingIndex(tokens, index + 3) === close - 1
    )
      return { from: index + 4, to: close - 1, async: isAsync, kind: 'block' };
    decline('unknown wrapper (only (() => …)() and (function () { … })() are rewritten)');
  }
  // A bare expression.
  const first = tokens[0];
  if (
    isPunct(tokens[last - 1], ')') &&
    isPunct(tokens[last - 2], '(') &&
    isPunct(tokens[last - 3], ')')
  )
    decline('unknown wrapper (only (() => …)() and (function () { … })() are rewritten)');
  if (first.kind === 'ident' && STATEMENT_START.has(first.value))
    decline(`the script is a \`${first.value}\` statement, not an expression or IIFE`);
  if (isPunct(first, '{')) decline('the script starts with a block');
  const top = topLevel(tokens, 0, last);
  if (top.some((token) => isPunct(token, '=>'))) decline('the script is already a function');
  if (top.some((token) => isPunct(token, ';')))
    decline('the script has several statements; wrap them in (() => { … })()');
  if (top.slice(1).some((token) => token.newlineBefore))
    decline('a top-level line break could end the statement (automatic semicolon insertion)');
  return { from: 0, to: last, async: false, kind: 'expression' };
}

// ---------------------------------------------------------------------------
// Steps and pipeline documents
// ---------------------------------------------------------------------------

function isEvaluateOp(op: unknown): boolean {
  return typeof op === 'string' && (op === 'browser:evaluate' || op === 'evaluate');
}

/** Suggest the args rewrite of one evaluate step (authored, unexpanded params). */
export function suggestEvaluateStepArgs(
  step: unknown,
  /** Variables `secret:get` steps of the pipeline export (never moved into args). */
  options: { secretVariables?: Iterable<string> } = {}
): ArgsSuggestion {
  if (!isRecord(step)) return { ok: false, reason: 'not a step' };
  if (!isEvaluateOp(step.op))
    return { ok: false, reason: `${String(step.op)} is not browser:evaluate` };
  const params = isRecord(step.params) ? step.params : {};
  if (typeof params.script !== 'string') return { ok: false, reason: 'the script is not a string' };
  if (params.args !== undefined)
    return {
      ok: false,
      reason: 'the step already passes args; move the remaining templates into them by hand',
    };
  const elsewhere = Object.entries(params).find(
    ([key, value]) =>
      key !== 'script' && typeof value === 'string' && templateSites(value).length > 0
  );
  if (elsewhere)
    return { ok: false, reason: `the ${elsewhere[0]} param is templated, not the script` };
  return suggestScriptArgsRewrite(params.script, options);
}

/**
 * The authored step at a Run Manifest entry id (`3`, `2.pipeline.0`,
 * `4.cases.1.steps.0`, `5.on_error.fallback.0`).
 */
export function locateStepByEntryId(
  steps: unknown,
  entryId: string
): Record<string, unknown> | undefined {
  let current: unknown = steps;
  for (const segment of entryId.split('.')) {
    if (Array.isArray(current) && /^\d+$/u.test(segment)) current = current[Number(segment)];
    else if (isRecord(current) && typeof current.op === 'string')
      current =
        segment === 'on_error'
          ? current.on_error
          : isRecord(current.params)
            ? current.params[segment]
            : undefined;
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return isRecord(current) ? current : undefined;
}

export interface PipelineArgsSuggestionResult {
  /** Entry-id style path of the step. */
  step_path: string;
  suggestion: ArgsSuggestion;
}

/**
 * Rewrite every templated `browser:evaluate` script of a pipeline document
 * (parsed JSON) where a suggestion exists. Returns a new document; the input
 * is not modified.
 */
export function suggestArgsForPipelineDocument(document: unknown): {
  document: unknown;
  results: PipelineArgsSuggestionResult[];
} {
  const results: PipelineArgsSuggestionResult[] = [];
  const copy = structuredClone(document);
  const secretVariables = isRecord(document) ? secretExportVariables(document.steps) : new Set();
  const visitSteps = (body: unknown, prefix: string, depth: number) => {
    if (!Array.isArray(body) || depth > 32) return;
    body.forEach((step, index) => {
      if (!isRecord(step)) return;
      const path = prefix ? `${prefix}.${index}` : String(index);
      const params = isRecord(step.params) ? step.params : undefined;
      if (
        isEvaluateOp(step.op) &&
        params &&
        typeof params.script === 'string' &&
        templateSites(params.script).length
      ) {
        const suggestion = suggestEvaluateStepArgs(step, {
          secretVariables: secretVariables as Set<string>,
        });
        results.push({ step_path: path, suggestion });
        if ('script' in suggestion) {
          params.script = suggestion.script;
          params.args = suggestion.args;
        }
      }
      if (params)
        for (const [key, value] of Object.entries(params)) {
          if (Array.isArray(value)) visitSteps(value, `${path}.${key}`, depth + 1);
          if (key === 'cases' && Array.isArray(value))
            value.forEach((entry, caseIndex) => {
              if (!isRecord(entry)) return;
              for (const caseKey of ['steps', 'then', 'pipeline', 'do'])
                visitSteps(entry[caseKey], `${path}.cases.${caseIndex}.${caseKey}`, depth + 1);
            });
        }
      if (isRecord(step.on_error))
        visitSteps(step.on_error.fallback, `${path}.on_error.fallback`, depth + 1);
    });
  };
  if (isRecord(copy)) visitSteps(copy.steps, '', 0);
  return { document: copy, results };
}

/** The caveat printed with every suggestion (see the equivalence note above). */
export const ARGS_SUGGESTION_CAVEAT =
  'caveat: args arrive as data, not code — a numeric string stays a string (compare with String(...)) and an unset variable arrives as ""';

/** One compact line: the ready-to-paste params (with the caveat), or why none was generated. */
export function formatArgsSuggestion(stepPath: string, suggestion: ArgsSuggestion): string {
  if ('reason' in suggestion) return `step ${stepPath}: no args suggestion — ${suggestion.reason}`;
  const snippet = `"script": ${JSON.stringify(suggestion.script)}, "args": ${JSON.stringify(suggestion.args)}`;
  return `step ${stepPath}: ${snippet}${suggestion.note ? ` (${suggestion.note})` : ''} — ${ARGS_SUGGESTION_CAVEAT}`;
}
