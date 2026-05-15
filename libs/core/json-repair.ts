/**
 * Lightweight JSON repair helpers for common model/CLI output defects.
 *
 * This intentionally stays conservative: it returns null rather than guessing
 * when the input cannot be made parseable through low-risk structural fixes.
 */

export function tryRepairJson(input: string): unknown | null {
  const repaired = repairJsonString(input);
  if (repaired === null) return null;

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

export function repairJsonString(input: string): string | null {
  const candidates = buildCandidates(input);

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next, slightly more permissive normalization.
    }
  }

  return null;
}

function buildCandidates(input: string): string[] {
  const normalized = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const extracted = extractJsonFragment(stripMarkdownFence(normalized));
  if (!extracted) return [];

  const noTrailingCommas = removeTrailingCommas(extracted);
  const quotedKeys = quoteUnquotedKeys(noTrailingCommas);
  const doubleQuoted = replaceSingleQuotedStrings(quotedKeys);

  return unique([
    extracted,
    noTrailingCommas,
    quotedKeys,
    doubleQuoted,
  ]);
}

function stripMarkdownFence(input: string): string {
  const fence = input.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fence ? fence[1].trim() : input;
}

function extractJsonFragment(input: string): string | null {
  const start = findFirstJsonStart(input);
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let quote = '';

  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
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
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return input.slice(start, i + 1).trim();
      stack.pop();
      if (stack.length === 0) return input.slice(start, i + 1).trim();
    }
  }

  return input.slice(start).trim();
}

function findFirstJsonStart(input: string): number {
  const object = input.indexOf('{');
  const array = input.indexOf('[');
  if (object === -1) return array;
  if (array === -1) return object;
  return Math.min(object, array);
}

function removeTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let quote = '';

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
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
      if (/^\s*[\]}]/.test(rest)) continue;
    }
    out += ch;
  }

  return out;
}

function quoteUnquotedKeys(input: string): string {
  return input.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
}

function replaceSingleQuotedStrings(input: string): string {
  return input.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body: string) => {
    return `"${body.replace(/"/g, '\\"')}"`;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
