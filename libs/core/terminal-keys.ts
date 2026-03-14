/**
 * Symbolic Key Mapper for Terminal
 * Translates abstract key names to ANSI escape sequences.
 */

const ESC = '\x1b';

const KEY_MAP: Record<string, string> = {
  'enter': '\r',
  'return': '\r',
  'tab': '\t',
  'escape': ESC,
  'backspace': '\x7f',
  'up': `${ESC}[A`,
  'down': `${ESC}[B`,
  'right': `${ESC}[C`,
  'left': `${ESC}[D`,
  'home': `${ESC}[1~`,
  'end': `${ESC}[4~`,
  'pageup': `${ESC}[5~`,
  'pagedown': `${ESC}[6~`,
  'delete': `${ESC}[3~`,
};

/**
 * Encodes a string or a list of symbolic keys into terminal input data.
 * Supports: "ls -F", ["Ctrl-C"], ["Up", "Enter"]
 */
export function encodeTerminalInput(input: string | string[]): string {
  if (typeof input === 'string') {
    return input;
  }

  return input.map(key => {
    const lowerKey = key.toLowerCase();
    
    // Handle Ctrl combinations (e.g., "Ctrl-C")
    if (lowerKey.startsWith('ctrl-') && lowerKey.length === 6) {
      const char = lowerKey[5];
      const code = char.charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) {
        return String.fromCharCode(code);
      }
    }

    return KEY_MAP[lowerKey] || key;
  }).join('');
}
