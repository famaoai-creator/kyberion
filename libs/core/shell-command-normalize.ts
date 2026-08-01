/**
 * Shell command de-obfuscation for policy scanning (QM-05).
 *
 * Ported from yc-software/qm (MIT License, commit 7f2c916):
 *   src/policy/command-policy.ts (scannableCommand + payload extraction)
 *   src/util/safe-regex.ts (ReDoS-guarded rule compilation)
 *
 * Constraint this module must uphold: policy rules are evaluated AFTER
 * de-obfuscation, so `timeout -s KILL 30 rm -rf /`, ANSI-C quoting,
 * `sh -c '...'`, piped literal producers (`echo ... | sh`), here-strings and
 * simple variable indirection all resolve to the underlying command text.
 * This is a speed bump against mistakes and injection, not a sandbox boundary.
 */

const MAX_PATTERN_CHARS = 256;
const MAX_SCAN_DEPTH = 8;

export function compileSafeRegex(pattern: string, flags = ''): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  }
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) {
    throw new Error('backreferences and lookarounds are not supported');
  }
  const groups: Array<{ quantified: boolean; alternation: boolean }> = [];
  let escaped = false;
  let inClass = false;
  let previousQuantifier = false;
  let closed: { quantified: boolean; alternation: boolean } | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (ch === '(') {
      groups.push({ quantified: false, alternation: false });
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === '|') {
      if (groups.length) groups[groups.length - 1]!.alternation = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ')') {
      closed = groups.pop() ?? { quantified: false, alternation: false };
      previousQuantifier = false;
      continue;
    }
    const quantifier =
      ch === '*' || ch === '+' || (ch === '?' && pattern[i - 1] !== '(') || ch === '{';
    if (quantifier) {
      if (previousQuantifier || (closed && (closed.quantified || closed.alternation))) {
        throw new Error('nested or ambiguous repetition is not supported');
      }
      if (groups.length) groups[groups.length - 1]!.quantified = true;
      previousQuantifier = true;
      closed = null;
      continue;
    }
    previousQuantifier = false;
    closed = null;
  }
  return new RegExp(pattern, flags);
}

function decodeAnsiC(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCodePoint(Number.parseInt(octal, 8))
    )
    .replace(
      /\\([\\'"abefnrtv])/g,
      (_, escape: string) =>
        ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' })[escape] ??
        escape
    );
}

function unquoteBareWord(inner: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(inner) ? inner : undefined;
}

function stripWrittenHeredocs(command: string): string {
  return command.replace(
    /^([^\n]*)<<-?\s*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$/gm,
    (full, pre, _q, _delim, post) =>
      /[>]/.test(pre + post) && !heredocRunsShell(pre + post) ? '' : full
  );
}

function heredocRunsShell(commandLine: string): boolean {
  const shells = /(?:^|[|;&]\s*)(?:\S*\/)?(?:ba|da|k|z)?sh((?:\s+[^|;&]*)?)/g;
  return [...commandLine.matchAll(shells)].some(
    (match) => !/(?:^|\s)-[^-\s]*c(?:\s|$)/.test(match[1] ?? '')
  );
}

interface ShellScan {
  commands: string[][];
  nested: string[];
}

function scanShell(input: string): ShellScan {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let i = 0;
  const flush = () => {
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const commandSubstitution = (start: number): { body: string; end: number } | undefined => {
    let depth = 1;
    let quote = '';
    for (let j = start + 2; j < input.length; j++) {
      const c = input.charAt(j);
      if (c === '\\') {
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === '$' && input.charAt(j + 1) === '(') {
        depth++;
        j++;
      } else if (c === ')' && --depth === 0) {
        return { body: input.slice(start + 2, j), end: j + 1 };
      }
    }
    return undefined;
  };
  while (i < input.length) {
    if (/\s/.test(input.charAt(i))) {
      if (input.charAt(i) === '\n') flush();
      i++;
      continue;
    }
    if (input.charAt(i) === '#' && words.length === 0) {
      while (i < input.length && input.charAt(i) !== '\n') i++;
      continue;
    }
    if (';|&(){}'.includes(input.charAt(i))) {
      flush();
      while (i < input.length && ';|&(){}'.includes(input.charAt(i))) i++;
      continue;
    }
    let word = '';
    let wordStarted = false;
    while (
      i < input.length &&
      !/\s/.test(input.charAt(i)) &&
      (!';|&(){}'.includes(input.charAt(i)) || (input.charAt(i) === '&' && /[<>]$/.test(word)))
    ) {
      const c = input.charAt(i);
      if (c === '\\') {
        if (input.charAt(i + 1) === '\n') i += 2;
        else if (i + 1 < input.length) {
          wordStarted = true;
          word += input.charAt(i + 1);
          i += 2;
        } else i++;
        continue;
      }
      if (c === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 1);
        if (end < 0) {
          word += input.slice(i + 1);
          i = input.length;
        } else {
          word += input.slice(i + 1, end);
          i = end + 1;
        }
        continue;
      }
      if (c === '$' && input.charAt(i + 1) === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 2);
        if (end < 0) {
          word += input.slice(i + 2);
          i = input.length;
        } else {
          word += decodeAnsiC(input.slice(i + 2, end));
          i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        wordStarted = true;
        i++;
        while (i < input.length && input.charAt(i) !== '"') {
          if (input.charAt(i) === '\\' && i + 1 < input.length) {
            word += input.charAt(i + 1);
            i += 2;
          } else if (input.charAt(i) === '$' && input.charAt(i + 1) === '(') {
            const sub = commandSubstitution(i);
            if (!sub) {
              word += input.charAt(i++);
            } else {
              nested.push(sub.body);
              i = sub.end;
            }
          } else if (input.charAt(i) === '`') {
            const end = input.indexOf('`', i + 1);
            if (end < 0) i++;
            else {
              nested.push(input.slice(i + 1, end));
              i = end + 1;
            }
          } else word += input.charAt(i++);
        }
        if (input.charAt(i) === '"') i++;
        continue;
      }
      if (c === '$' && input.charAt(i + 1) === '(') {
        wordStarted = true;
        const sub = commandSubstitution(i);
        if (!sub) word += input.charAt(i++);
        else {
          nested.push(sub.body);
          i = sub.end;
        }
        continue;
      }
      if (c === '`') {
        wordStarted = true;
        const end = input.indexOf('`', i + 1);
        if (end < 0) i++;
        else {
          nested.push(input.slice(i + 1, end));
          i = end + 1;
        }
        continue;
      }
      word += c;
      wordStarted = true;
      i++;
    }
    if (wordStarted) words.push(word);
  }
  flush();
  return { commands, nested };
}

function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(word) || /^(?:if|then|elif|else|while|until|do|!)$/.test(word)) i++;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&)$/.test(word)) i += 2;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&).+/.test(word)) i++;
    else break;
  }
  return i;
}

function optionCommand(words: string[], start: number, valueOptions: Set<string>): number {
  let i = start;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') return i + 1;
    if (!word.startsWith('-') || word === '-') return i;
    const name = word.replace(/=.*/, '');
    if (valueOptions.has(name) && !word.includes('=')) i++;
  }
  return i;
}

const SUDO_VALUE_OPTIONS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--chdir',
  '-T',
  '--command-timeout',
  '-R',
  '--chroot',
  '-t',
  '--type',
]);
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
const TIMEOUT_VALUE_OPTIONS = new Set(['-s', '--signal', '-k', '--kill-after']);
const TIME_VALUE_OPTIONS = new Set(['-o', '--output', '-f', '--format']);
const STDBUF_VALUE_OPTIONS = new Set(['-i', '--input', '-o', '--output', '-e', '--error']);
const SHELL_EXECUTABLES = ['bash', 'sh', 'dash', 'zsh', 'ksh'];

function splitStringPayload(
  args: string[],
  split: number
): { value: string | undefined; rest: string[] } {
  const arg = args[split]!;
  const compact = arg.startsWith('-S') && arg.length > 2;
  let value = args[split + 1];
  if (arg.includes('=')) value = arg.slice(arg.indexOf('=') + 1);
  else if (compact) value = arg.slice(2);
  const rest = args.slice(split + (arg.includes('=') || compact ? 1 : 2));
  return { value, rest };
}

function envSplitWords(args: string[]): string[] | undefined {
  const split = args.findIndex(
    (arg) =>
      arg === '-S' ||
      arg.startsWith('-S') ||
      arg === '--split-string' ||
      arg.startsWith('--split-string=')
  );
  if (split < 0) return undefined;
  const { value, rest } = splitStringPayload(args, split);
  if (value === undefined) return [];
  return scanShell([value, ...rest].join(' ')).commands[0] ?? [];
}

function shellPipelines(input: string): string[][] {
  const pipelines: string[][] = [];
  let pipeline: string[] = [];
  let start = 0;
  let quote = '';
  const finishSegment = (end: number) => {
    const segment = input.slice(start, end).trim();
    if (segment) pipeline.push(segment);
  };
  const finishPipeline = (end: number) => {
    finishSegment(end);
    if (pipeline.length > 1) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if ((char === '|' || char === '&') && input.charAt(i + 1) === char) {
      finishPipeline(i);
      i++;
      start = i + 1;
      continue;
    }
    if (char === '|') {
      finishSegment(i);
      if (input.charAt(i + 1) === '&') i++;
      start = i + 1;
      continue;
    }
    if (char === ';' || char === '\n' || char === '&') {
      finishPipeline(i);
      start = i + 1;
    }
  }
  finishPipeline(input.length);
  return pipelines;
}

function segmentConsumesShellStdin(words: string[]): boolean {
  const start = commandStart(words);
  if (start >= words.length) return false;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);
  if (SHELL_EXECUTABLES.includes(executable)) {
    const stdinScripts = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (/^-[^-]*c/.test(arg)) return false;
      if (arg === '-s') return true;
      if (['-O', '-o', '--rcfile', '--init-file'].includes(arg)) {
        i++;
        continue;
      }
      if (arg === '--') return args[i + 1] === undefined || stdinScripts.has(args[i + 1]!);
      if (!arg.startsWith('-') || arg === '-') return stdinScripts.has(arg);
    }
    return true;
  }
  if (executable === 'env') {
    const split = envSplitWords(args);
    if (split) return segmentConsumesShellStdin(split);
    let next = optionCommand(args, 0, ENV_VALUE_OPTIONS);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return segmentConsumesShellStdin(args.slice(next));
  }
  if (executable === 'command')
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set())));
  if (executable === 'exec')
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set(['-a']))));
  if (executable === 'sudo') {
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, SUDO_VALUE_OPTIONS)));
  }
  if (executable === 'nice')
    return segmentConsumesShellStdin(
      args.slice(optionCommand(args, 0, new Set(['-n', '--adjustment'])))
    );
  if (executable === 'timeout') {
    const duration = optionCommand(args, 0, TIMEOUT_VALUE_OPTIONS);
    return segmentConsumesShellStdin(args.slice(duration + 1));
  }
  if (executable === 'time')
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, TIME_VALUE_OPTIONS)));
  if (executable === 'nohup')
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set())));
  if (executable === 'stdbuf') {
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, STDBUF_VALUE_OPTIONS)));
  }
  return false;
}

function literalProducerPayload(words: string[]): string | undefined {
  const start = commandStart(words);
  if (start >= words.length) return undefined;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  let args = words.slice(start + 1);
  if (executable === 'command') {
    let next = 0;
    for (; next < args.length; next++) {
      if (args[next] === '--') {
        next++;
        break;
      }
      if (args[next] === '-v' || args[next] === '-V') return undefined;
      if (args[next] !== '-p') break;
    }
    return literalProducerPayload(args.slice(next));
  }
  if (executable === 'builtin') {
    if (args[0]?.startsWith('-') && args[0] !== '--') return undefined;
    return literalProducerPayload(args[0] === '--' ? args.slice(1) : args);
  }
  if (executable === 'exec')
    return literalProducerPayload(args.slice(optionCommand(args, 0, new Set(['-a']))));
  if (executable === 'env') {
    const split = envSplitWords(args);
    if (split) return literalProducerPayload(split);
    let next = optionCommand(args, 0, new Set(['-u', '--unset', '-C', '--chdir']));
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return literalProducerPayload(args.slice(next));
  }
  if (executable === 'sudo') {
    return literalProducerPayload(args.slice(optionCommand(args, 0, SUDO_VALUE_OPTIONS)));
  }
  if (executable === 'nice')
    return literalProducerPayload(
      args.slice(optionCommand(args, 0, new Set(['-n', '--adjustment'])))
    );
  if (executable === 'timeout') {
    const duration = optionCommand(args, 0, TIMEOUT_VALUE_OPTIONS);
    return literalProducerPayload(args.slice(duration + 1));
  }
  if (executable === 'time')
    return literalProducerPayload(args.slice(optionCommand(args, 0, TIME_VALUE_OPTIONS)));
  if (executable === 'nohup')
    return literalProducerPayload(args.slice(optionCommand(args, 0, new Set())));
  if (executable === 'stdbuf')
    return literalProducerPayload(args.slice(optionCommand(args, 0, STDBUF_VALUE_OPTIONS)));
  if (args[0] === '--') args = args.slice(1);
  if (executable === 'echo') {
    let decodeEscapes = false;
    while (/^-[neE]+$/.test(args[0] ?? '')) {
      for (const option of args[0]!.slice(1)) {
        if (option === 'e') decodeEscapes = true;
        if (option === 'E') decodeEscapes = false;
      }
      args = args.slice(1);
    }
    const payload = args.join(' ');
    return decodeEscapes ? decodeAnsiC(payload) : payload;
  }
  if (executable !== 'printf' || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const rendered = decodeAnsiC(format!).replace(/%([%sb])/g, (_match, conversion: string) => {
    if (conversion === '%') return '%';
    const value = values[valueIndex++] ?? '';
    return conversion === 'b' ? decodeAnsiC(value) : value;
  });
  return [rendered, ...values.slice(valueIndex), args.join(' ')].join('\n');
}

function pipedShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  for (const pipeline of shellPipelines(input)) {
    for (let i = 1; i < pipeline.length; i++) {
      const consumer = scanShell(pipeline[i]!).commands[0];
      if (!consumer || !segmentConsumesShellStdin(consumer)) continue;
      const producerCommands = scanShell(pipeline[i - 1]!).commands;
      const producer = producerCommands.at(-1);
      if (!producer) continue;
      const payload = literalProducerPayload(producer);
      if (payload) payloads.push(payload);
    }
  }
  return payloads;
}

function hereStringShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  let spaced = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === '\\') {
      spaced += input.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      spaced += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      spaced += char;
      continue;
    }
    if (input.startsWith('<<<', i)) {
      spaced += ' <<< ';
      i += 2;
      continue;
    }
    spaced += char;
  }
  for (const words of scanShell(spaced).commands) {
    const redirect = words.indexOf('<<<');
    if (redirect <= 0 || !segmentConsumesShellStdin(words.slice(0, redirect))) continue;
    const payload = words[redirect + 1];
    if (payload) payloads.push(payload);
  }
  return payloads;
}

function simpleVariablePayloads(input: string): string[] {
  const values = new Map<string, string>();
  const payloads: string[] = [];
  const executableIndex = (words: string[], offset = 0): number | undefined => {
    const start = commandStart(words);
    if (start >= words.length) return undefined;
    const executableWord = words[start]!;
    const executable = executableWord.split('/').pop() ?? executableWord;
    const args = words.slice(start + 1);
    let next: number | undefined;
    if (executable === 'command' || executable === 'nohup')
      next = optionCommand(args, 0, new Set());
    else if (executable === 'exec') next = optionCommand(args, 0, new Set(['-a']));
    else if (executable === 'env') {
      next = optionCommand(args, 0, ENV_VALUE_OPTIONS);
      while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    } else if (executable === 'sudo') {
      next = optionCommand(args, 0, SUDO_VALUE_OPTIONS);
    } else if (executable === 'nice')
      next = optionCommand(args, 0, new Set(['-n', '--adjustment']));
    else if (executable === 'timeout') next = optionCommand(args, 0, TIMEOUT_VALUE_OPTIONS) + 1;
    else if (executable === 'time') next = optionCommand(args, 0, TIME_VALUE_OPTIONS);
    else if (executable === 'stdbuf') next = optionCommand(args, 0, STDBUF_VALUE_OPTIONS);
    if (next === undefined) return offset + start;
    return executableIndex(args.slice(next), offset + start + 1 + next);
  };
  for (const words of scanShell(input).commands) {
    const start = commandStart(words);
    if (start >= words.length) {
      for (const word of words) {
        const match = /^([A-Za-z_]\w*)=([\w./-]+)$/.exec(word);
        if (match) values.set(match[1]!, match[2]!);
      }
      continue;
    }
    const index = executableIndex(words);
    if (index === undefined) continue;
    const match = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(words[index]!);
    const value = values.get(match?.[1] ?? match?.[2] ?? '');
    if (value)
      payloads.push([...words.slice(0, index), value, ...words.slice(index + 1)].join(' '));
  }
  return payloads;
}

function segmentShellPayloads(words: string[]): string[] {
  const start = commandStart(words);
  if (start >= words.length) return [];
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);
  if (SHELL_EXECUTABLES.includes(executable)) {
    for (let j = 0; j < args.length; j++) {
      if (args[j] === '--' || !args[j]!.startsWith('-')) return [];
      if (['-O', '-o', '--rcfile', '--init-file'].includes(args[j]!)) {
        j++;
        continue;
      }
      if (/^-[^-]*c/.test(args[j]!)) return args[j + 1] === undefined ? [] : [args[j + 1]!];
    }
    return [];
  }
  if (executable === 'eval') return args.length ? [args.join(' ')] : [];
  if (executable === 'env') {
    const split = args.findIndex(
      (arg) =>
        arg === '-S' ||
        arg.startsWith('-S') ||
        arg === '--split-string' ||
        arg.startsWith('--split-string=')
    );
    if (split >= 0) {
      const { value, rest } = splitStringPayload(args, split);
      return value === undefined ? [] : [[value, ...rest].join(' ')];
    }
    let next = optionCommand(args, 0, ENV_VALUE_OPTIONS);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return segmentShellPayloads(args.slice(next));
  }
  if (executable === 'command') {
    let next = 0;
    for (; next < args.length; next++) {
      if (args[next] === '--') {
        next++;
        break;
      }
      if (args[next] === '-v' || args[next] === '-V') return [];
      if (args[next] !== '-p') break;
    }
    return segmentShellPayloads(args.slice(next));
  }
  if (executable === 'exec')
    return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set(['-a']))));
  if (executable === 'sudo') {
    return segmentShellPayloads(args.slice(optionCommand(args, 0, SUDO_VALUE_OPTIONS)));
  }
  if (executable === 'nice')
    return segmentShellPayloads(
      args.slice(optionCommand(args, 0, new Set(['-n', '--adjustment'])))
    );
  if (executable === 'timeout') {
    const duration = optionCommand(args, 0, TIMEOUT_VALUE_OPTIONS);
    return segmentShellPayloads(args.slice(duration + 1));
  }
  if (executable === 'time')
    return segmentShellPayloads(args.slice(optionCommand(args, 0, TIME_VALUE_OPTIONS)));
  if (executable === 'nohup')
    return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set())));
  if (executable === 'coproc') return segmentShellPayloads(args);
  if (executable === 'xargs') {
    const next = optionCommand(
      args,
      0,
      new Set([
        '-a',
        '--arg-file',
        '-d',
        '--delimiter',
        '-E',
        '--eof',
        '-I',
        '--replace',
        '-L',
        '--max-lines',
        '-n',
        '--max-args',
        '-P',
        '--max-procs',
        '-s',
        '--max-chars',
      ])
    );
    return segmentShellPayloads(args.slice(next));
  }
  return [];
}

function executedShellPayloads(input: string): string[] {
  const scan = scanShell(input);
  return [
    ...scan.nested,
    ...scan.commands.flatMap(segmentShellPayloads),
    ...pipedShellPayloads(input),
    ...hereStringShellPayloads(input),
    ...simpleVariablePayloads(input),
  ];
}

function scannableCommandAtDepth(command: string, depth: number): string {
  const stripped = stripWrittenHeredocs(command);
  const base = stripped
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
      const subs = m.match(/\$\([^)]*\)|`[^`]*`/g);
      if (subs) return subs.join(' ');
      return unquoteBareWord(m.slice(1, -1)) ?? '""';
    })
    .replace(
      /\$'((?:[^'\\]|\\.)*)'/g,
      (_m, inner: string) => unquoteBareWord(decodeAnsiC(inner)) ?? "''"
    )
    .replace(/'[^']*'/g, (m) => unquoteBareWord(m.slice(1, -1)) ?? "''")
    .replace(/\\([\w@%+=:,./-])/g, '$1');
  if (depth >= MAX_SCAN_DEPTH) return base;
  const executed = executedShellPayloads(stripped);
  if (!executed.length) return base;
  return [base, ...executed.map((payload) => scannableCommandAtDepth(payload, depth + 1))].join(
    '\n'
  );
}

export function scannableCommand(command: string): string {
  return scannableCommandAtDepth(command, 0);
}

/**
 * The command plus every executed payload it can be de-obfuscated into,
 * whitespace-collapsed and deduplicated. The first unit is always the
 * (de-quoted) base command; later units are nested/wrapped payloads.
 */
export function scannableUnits(command: string): string[] {
  const seen = new Set<string>();
  const units: string[] = [];
  for (const line of scannableCommand(command).split('\n')) {
    const collapsed = line.trim().replace(/\s+/g, ' ');
    if (!collapsed || seen.has(collapsed)) continue;
    seen.add(collapsed);
    units.push(collapsed);
  }
  return units;
}

export interface SimpleCommand {
  executable: string;
  args: string[];
}

/**
 * Review finding (batch-1): de-obfuscation must be ASYMMETRIC. Seeing through
 * sudo, env prefixes, quotes and wrappers is right when looking for something
 * to BLOCK, and unsafe when looking for a reason to PERMIT. The allow path
 * therefore evaluates the ORIGINAL word sequence via allowableCommands(),
 * which returns null the moment anything privilege- or write-shaped appears.
 */
export interface AllowCandidate {
  executable: string;
  args: string[];
  /** The original (post-benign-unwrap) words joined — what allow rules match against. */
  display: string;
}

const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas', 'su']);
const BENIGN_WRAPPERS: Record<string, Set<string>> = {
  timeout: TIMEOUT_VALUE_OPTIONS,
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set<string>(),
  time: TIME_VALUE_OPTIONS,
  stdbuf: STDBUF_VALUE_OPTIONS,
};
const SAFE_ENV_ASSIGNMENT_NAMES = new Set([
  'CI',
  'LANG',
  'TZ',
  'NODE_ENV',
  'DEBUG',
  'NO_COLOR',
  'FORCE_COLOR',
  'COLUMNS',
  'LINES',
]);

function safeEnvAssignment(word: string): boolean {
  const match = /^([A-Za-z_]\w*)=/.exec(word);
  if (!match) return false;
  const name = match[1]!;
  return SAFE_ENV_ASSIGNMENT_NAMES.has(name) || name.startsWith('LC_');
}

function writeRedirectWord(word: string): boolean {
  return /^(?:\d*|&)>/.test(word) || word === '>|';
}

const RISKY_ARG_GUARDS: Record<string, (args: string[]) => boolean> = {
  find: (args) =>
    args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fls|fprint0?|fprintf)$/.test(arg)),
  sed: (args) =>
    args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg.startsWith('--in-place')),
  sort: (args) => args.some((arg) => arg === '-o' || arg.startsWith('--output')),
};
const AWK_EXECUTABLES = new Set(['awk', 'gawk', 'mawk', 'nawk']);

function riskyArgs(executable: string, args: string[]): boolean {
  const base = executable.split('/').pop() ?? executable;
  if (AWK_EXECUTABLES.has(base)) {
    return args.some((arg) => arg.includes('system(') || arg.includes('>'));
  }
  const guard = RISKY_ARG_GUARDS[base];
  return guard ? guard(args) : false;
}

/**
 * The simple commands of the ORIGINAL input, for allowlist evaluation only.
 * Returns null ("not allowlistable") when the input carries a privilege
 * wrapper, an unsafe env assignment, a write redirect, or a risky argument to
 * a command that can execute or write through an innocuous-looking head
 * (find -exec, sed -i, awk system()/print-redirect, sort -o). Benign wrappers
 * (timeout, nice, nohup, time, stdbuf, env with safe assignments) are
 * unwrapped; everything else keeps its original spelling so anchored allow
 * rules match exactly what was typed.
 */
export function allowableCommands(input: string): AllowCandidate[] | null {
  const candidates: AllowCandidate[] = [];
  for (const words of scanShell(input).commands) {
    let index = 0;
    while (index < words.length) {
      const word = words[index]!;
      if (/^(?:if|then|elif|else|while|until|do|!)$/.test(word)) {
        index++;
        continue;
      }
      if (/^[A-Za-z_]\w*=/.test(word)) {
        if (!safeEnvAssignment(word)) return null;
        index++;
        continue;
      }
      if (/^\d*(?:<<?|<>|<&)$/.test(word)) {
        index += 2;
        continue;
      }
      if (/^\d*(?:<<?|<>|<&)./.test(word)) {
        index++;
        continue;
      }
      break;
    }
    if (words.slice(index).some(writeRedirectWord)) return null;
    if (index >= words.length) continue;

    let rest = words.slice(index);
    for (;;) {
      const head = rest[0]!;
      const base = head.split('/').pop() ?? head;
      if (PRIVILEGE_WRAPPERS.has(base)) return null;
      if (base === 'env') {
        let next = 1;
        while (next < rest.length && /^[A-Za-z_]\w*=/.test(rest[next]!)) {
          if (!safeEnvAssignment(rest[next]!)) return null;
          next++;
        }
        if (next < rest.length && rest[next]!.startsWith('-')) return null;
        if (next >= rest.length) break;
        rest = rest.slice(next);
        continue;
      }
      const benign = BENIGN_WRAPPERS[base];
      if (benign) {
        let next = optionCommand(rest.slice(1), 0, benign) + 1;
        if (base === 'timeout') next += 1;
        if (next >= rest.length) break;
        rest = rest.slice(next);
        continue;
      }
      break;
    }
    if (rest.length === 0) continue;
    const executable = rest[0]!;
    const args = rest.slice(1);
    if (riskyArgs(executable, args)) return null;
    candidates.push({ executable, args, display: rest.join(' ') });
  }
  return candidates;
}

/**
 * The simple commands inside one scannable unit, with wrapper executables
 * (sudo, env, nice, timeout, time, nohup, stdbuf, command, exec) unwrapped so
 * `timeout -s KILL 30 rm -rf /` resolves to executable `rm`.
 */
export function simpleCommands(unit: string): SimpleCommand[] {
  const results: SimpleCommand[] = [];
  for (const words of scanShell(unit).commands) {
    const resolved = resolveCoreCommand(words);
    if (resolved) results.push(resolved);
  }
  return results;
}

function resolveCoreCommand(words: string[]): SimpleCommand | undefined {
  const start = commandStart(words);
  if (start >= words.length) return undefined;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);
  let next: number | undefined;
  if (executable === 'command' || executable === 'nohup') next = optionCommand(args, 0, new Set());
  else if (executable === 'exec') next = optionCommand(args, 0, new Set(['-a']));
  else if (executable === 'env') {
    next = optionCommand(args, 0, ENV_VALUE_OPTIONS);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
  } else if (executable === 'sudo') next = optionCommand(args, 0, SUDO_VALUE_OPTIONS);
  else if (executable === 'nice') next = optionCommand(args, 0, new Set(['-n', '--adjustment']));
  else if (executable === 'timeout') next = optionCommand(args, 0, TIMEOUT_VALUE_OPTIONS) + 1;
  else if (executable === 'time') next = optionCommand(args, 0, TIME_VALUE_OPTIONS);
  else if (executable === 'stdbuf') next = optionCommand(args, 0, STDBUF_VALUE_OPTIONS);
  else if (executable === 'coproc') next = 0;
  if (next === undefined || next >= args.length) return { executable, args };
  return resolveCoreCommand(args.slice(next)) ?? { executable, args };
}
