import { describe, expect, it } from 'vitest';
import { MAX_TERMINAL_LINE_CHARS, sanitizeTerminalText } from './terminal-text.js';

describe('sanitizeTerminalText', () => {
  it('passes plain text through unchanged', () => {
    expect(sanitizeTerminalText('hello 世界')).toBe('hello 世界');
    expect(sanitizeTerminalText('multi\nline\ntext')).toBe('multi\nline\ntext');
  });

  it('strips CSI sequences from embedded child output', () => {
    expect(sanitizeTerminalText('ok \x1b[31mred\x1b[0m tail')).toBe('ok red tail');
    expect(sanitizeTerminalText('\x1b[2J\x1b[Hhidden')).toBe('hidden');
  });

  it('strips OSC sequences regardless of terminator', () => {
    expect(sanitizeTerminalText('a\x1b]8;;http://x\x07link\x1b]8;;\x07b')).toBe('alinkb');
    expect(sanitizeTerminalText('a\x1b]0;title\x1b\\b')).toBe('ab');
  });

  it('strips DCS and bare ESC forms', () => {
    expect(sanitizeTerminalText('a\x1bPpayload\x1b\\b')).toBe('ab');
    expect(sanitizeTerminalText('a\x1b(0b')).toBe('ab');
    expect(sanitizeTerminalText('a\x1b7b')).toBe('ab');
  });

  it('removes C0 controls, DEL, and C1 bytes but keeps newline', () => {
    expect(sanitizeTerminalText('a\x00b\x07c\x7fd\x9be\nf')).toBe('abcde\nf');
  });

  it('expands tabs so rendered cells stay aligned', () => {
    expect(sanitizeTerminalText('a\tb')).toBe('a  b');
  });

  it('repairs lone surrogates instead of emitting malformed UTF-8', () => {
    expect(sanitizeTerminalText('a\ud83db')).toBe('a\ufffdb');
  });

  it('clips overlong lines', () => {
    const long = 'x'.repeat(MAX_TERMINAL_LINE_CHARS + 10);
    const out = sanitizeTerminalText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TERMINAL_LINE_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is idempotent and handles non-string input', () => {
    const dirty = 'a\x1b[31mb\x00';
    expect(sanitizeTerminalText(sanitizeTerminalText(dirty))).toBe('ab');
    expect(sanitizeTerminalText(42)).toBe('42');
    expect(sanitizeTerminalText(null)).toBe('');
  });
});
