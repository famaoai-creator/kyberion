const ANSI_PARAM_CHARS = new Set(['[', '\\', '(', ')', '#', ';', '?']);

function isAlphaNum(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isOscBodyChar(ch: string): boolean {
  return isAlphaNum(ch) || '-/#&.:=?%@~_'.includes(ch);
}

function isCsiFinal(ch: string): boolean {
  const c = ch.charCodeAt(0);
  // `[\dA-PR-TZcf-nq-uy=><~]` from the original ANSI pattern
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 80) || // A-P
    (c >= 82 && c <= 84) || // R-T
    c === 90 || // Z
    (c >= 99 && c <= 102) || // c-f
    (c >= 110 && c <= 113) || // n-q
    (c >= 117 && c <= 121) || // u-y
    ch === '=' ||
    ch === '>' ||
    ch === '<' ||
    ch === '~'
  );
}

/**
 * Skip one escape sequence beginning at `index` (the ESC/C1 byte).
 * Mirrors the two branches of the well-known ansi-regex:
 *   `[[\]()#;?]* ( [a-zA-Z\d]* (?:;[-a-zA-Z\d/#&.:=?%@~_]+)* )? \u0007
 *               | (?:\d{1,4}(?:;\d{0,4})*)? [\dA-PR-TZcf-nq-uy=><~] )`
 */
function skipEscapeSequence(input: string, index: number): number {
  let i = index + 1;
  while (i < input.length && ANSI_PARAM_CHARS.has(input[i])) i += 1;

  // Branch A: OSC-ish body terminated by BEL
  {
    let j = i;
    while (j < input.length && isAlphaNum(input[j])) j += 1;
    while (j < input.length && input[j] === ';') {
      j += 1;
      const segStart = j;
      while (j < input.length && isOscBodyChar(input[j])) j += 1;
      if (j === segStart) break;
    }
    if (j < input.length && input[j] === '\u0007') return j + 1;
  }

  // Branch B: optional digit/';' params then a final byte
  {
    let j = i;
    while (j < input.length && (input[j] === ';' || (input[j] >= '0' && input[j] <= '9'))) j += 1;
    if (j < input.length && isCsiFinal(input[j])) return j + 1;
  }

  return index;
}

export function stripAnsi(input: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\u001B' || ch === '\u009B') {
      const next = skipEscapeSequence(input, i);
      if (next > i) {
        i = next;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}
