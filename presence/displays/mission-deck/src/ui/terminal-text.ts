/**
 * Terminal-safe text projection for everything the HUD draws.
 *
 * Panel rows, detail lines, log tails, peer transcripts, exec output, and
 * model replies are arbitrary text read back from files and child processes.
 * A stray ESC, CSI/OSC/DCS introducer, or control char inside a rendered
 * string reaches the tty verbatim and is interpreted by Terminal.app as a
 * real control sequence — desyncing its line model, which has already
 * crashed Terminal.app mid-render ("CFString cannot be created from a
 * negative number of bytes") and taken the whole window down.
 *
 * Every drawn string must pass through here: the wrapped <Text> component
 * (components/text.tsx), the TextInput value, and the --once snapshot path.
 */

/**
 * Complete or partially-written ANSI/VT sequences embedded in data:
 * CSI, OSC (BEL- or ST-terminated), DCS/SOS/PM/APC, and generic
 * ESC+intermediate+final forms (charset selects, DECSC/DECRC, …). Matching
 * whole sequences first keeps printable residue like "[31m" out of the
 * display.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE =
  /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|\x1b)|\x1b[PX^_][^\x1b]*(?:\x1b\\|\x1b)|\x1b[\x20-\x2f]*[\x30-\x7e]/gu;

/**
 * Remaining bytes that must never reach the tty: C0 controls other than
 * newline and tab (handled separately), DEL, and the C1 range — where 0x9B
 * alone already acts as CSI.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/gu;

/** Runaway lines are both unreadable and a known trigger class for terminal
 * renderer overflow bugs; clip rather than stream megabytes to the tty. */
export const MAX_TERMINAL_LINE_CHARS = 4096;
export const MAX_TERMINAL_TEXT_CHARS = 65536;

function clip(value: string): string {
  const clippedLines = value
    .split('\n')
    .map((line) =>
      line.length > MAX_TERMINAL_LINE_CHARS ? `${line.slice(0, MAX_TERMINAL_LINE_CHARS)}…` : line
    )
    .join('\n');
  return clippedLines.length > MAX_TERMINAL_TEXT_CHARS
    ? `${clippedLines.slice(0, MAX_TERMINAL_TEXT_CHARS)}…`
    : clippedLines;
}

/**
 * Project arbitrary text into a form that is safe to write to a terminal:
 * well-formed UTF-16, no escape/control sequences, no overlong lines.
 * Idempotent — sanitizing twice is a no-op, so callers may apply it at both
 * the data boundary and the render boundary.
 */
export function sanitizeTerminalText(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = typeof input === 'string' ? input : String(input);
  if (raw.length === 0) return raw;
  // Lone surrogates (e.g. from slicing an emoji) re-encode as U+FFFD; fix the
  // string itself so nothing downstream can emit a malformed UTF-8 stream.
  // (String#toWellFormed would do this, but the tsconfig lib is < ES2024.)
  const wellFormed = raw.replace(
    // eslint-disable-next-line no-control-regex
    /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/gu,
    (m) => (m.length === 2 ? m : '\ufffd')
  );
  const noAnsi = wellFormed.replace(ANSI_SEQUENCE, '');
  const noControl = noAnsi.replace(UNSAFE_CONTROL, '');
  return clip(noControl.replace(/\t/g, '  '));
}
