export interface Smell {
  type: string;
  line: number;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface AnalysisSummary {
  total: number;
  bySeverity: Record<'high' | 'medium' | 'low', number>;
}

export interface AnalysisResult {
  file: string;
  smells: Smell[];
  summary: AnalysisSummary;
}

export const THRESHOLDS = {
  maxFunctionLength: 50,
  maxNestingDepth: 4,
  maxLineLength: 120,
  magicNumberMin: 2,
};

const MAGIC_NUMBER_EXCEPTIONS = new Set([
  '0',
  '1',
  '-1',
  '2',
  '100',
  '1000',
  '0.0',
  '1.0',
  '0.5',
  '200',
  '201',
  '204',
  '301',
  '302',
  '400',
  '401',
  '403',
  '404',
  '500',
]);

export function detectLongFunctions(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  const functionPatterns = [
    /^\s*(async\s+)?function\s+(\w+)\s*\(/,
    /^\s*(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(.*\)\s*=>/,
    /^\s*(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function\s*\(/,
    /^\s*(\w+)\s*\(.*\)\s*\{/,
  ];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let functionName: string | null = null;

    for (const pattern of functionPatterns) {
      const match = line.match(pattern);
      if (match) {
        functionName = match[2] || match[1] || '(anonymous)';
        if (['async', 'const', 'let', 'var'].includes(functionName)) {
          functionName = match[2] || '(anonymous)';
        }
        break;
      }
    }

    if (functionName && line.includes('{')) {
      let braceDepth = 0;
      const functionStart = i;
      let j = i;
      let started = false;

      while (j < lines.length) {
        const currentLine = lines[j];
        for (const ch of currentLine) {
          if (ch === '{') {
            braceDepth++;
            started = true;
          }
          if (ch === '}') {
            braceDepth--;
          }
        }
        if (started && braceDepth === 0) {
          const functionLength = j - functionStart + 1;
          if (functionLength > THRESHOLDS.maxFunctionLength) {
            smells.push({
              type: 'long-function',
              line: functionStart + 1,
              detail: `Function "${functionName}" is ${functionLength} lines (max: ${THRESHOLDS.maxFunctionLength})`,
              severity: functionLength > THRESHOLDS.maxFunctionLength * 2 ? 'high' : 'medium',
            });
          }
          break;
        }
        j++;
      }
    }
    i++;
  }
  return smells;
}

export function detectDeepNesting(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  const nestingKeywords = /^\s*(if|else|for|while|switch|try|catch)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Also check brace-based nesting
    if (nestingKeywords.test(line) || line.trim().endsWith('{')) {
      let braceDepth = 0;
      for (let j = 0; j <= i; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
      }
      if (braceDepth > THRESHOLDS.maxNestingDepth) {
        smells.push({
          type: 'deep-nesting',
          line: i + 1,
          detail: `Nesting depth ${braceDepth} exceeds maximum of ${THRESHOLDS.maxNestingDepth}`,
          severity: braceDepth > THRESHOLDS.maxNestingDepth + 2 ? 'high' : 'medium',
        });
      }
    }
  }
  return smells;
}

export function detectLongLines(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > THRESHOLDS.maxLineLength) {
      smells.push({
        type: 'long-line',
        line: i + 1,
        detail: `Line is ${lines[i].length} chars (max: ${THRESHOLDS.maxLineLength})`,
        severity: 'low',
      });
    }
  }
  return smells;
}

export function detectDuplicatePatterns(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  const blockSize = 3;
  const seen = new Map<string, number>();

  for (let i = 0; i <= lines.length - blockSize; i++) {
    const block: string[] = [];
    for (let j = 0; j < blockSize; j++) {
      block.push(lines[i + j].trim());
    }
    // Skip empty or trivial blocks
    if (block.every((l) => !l || l === '{' || l === '}')) continue;
    if (block.join('').trim().length < 20) continue;

    const key = block.join('\\n');
    if (seen.has(key)) {
      const firstOccurrence = seen.get(key)!;
      if (
        !smells.some(
          (s) => s.type === 'duplicate-code' && s.detail.includes(`lines ${firstOccurrence}`)
        )
      ) {
        smells.push({
          type: 'duplicate-code',
          line: i + 1,
          detail: `Duplicate code block (${blockSize} lines) also found at lines ${firstOccurrence}-${firstOccurrence + blockSize - 1}`,
          severity: 'medium',
        });
      }
    } else {
      seen.set(key, i + 1);
    }
  }
  return smells;
}

export function detectMagicNumbers(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  const magicNumberPattern = /(?<!\w)(-?\d+\.?\d*)\b/g;
  const ignoreLinePatterns = [
    /^\s*\/\//,
    /^\s*\*/,
    /^\s*import\b/,
    /^\s*require\b/,
    /^\s*(const|let|var)\s+\w+\s*=\s*['"`]/,
    /\.port\s*[=:]/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ignoreLinePatterns.some((p) => p.test(line))) continue;

    let match;
    while ((match = magicNumberPattern.exec(line)) !== null) {
      const numStr = match[1];
      if (MAGIC_NUMBER_EXCEPTIONS.has(numStr)) continue;
      const beforeChar = line[match.index - 1] || '';
      if (beforeChar === '[' || beforeChar === '.') continue;

      smells.push({
        type: 'magic-number',
        line: i + 1,
        detail: `Magic number ${numStr} found - consider extracting to a named constant`,
        severity: 'low',
      });
    }
  }
  return smells;
}

export function detectMissingErrorHandling(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  const riskyPatterns = [
    { pattern: /JSON\.parse\s*\(/, label: 'JSON.parse()' },
    {
      pattern: /fs\.(readFileSync|writeFileSync|unlinkSync|mkdirSync)\s*\(/,
      label: 'synchronous fs operation',
    },
    { pattern: /require\s*\(\s*[^)]+\)/, label: 'require()' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    for (const risky of riskyPatterns) {
      if (risky.pattern.test(line)) {
        let insideTry = false;
        let braceDepth = 0;
        for (let j = i; j >= Math.max(0, i - 20); j--) {
          const prevLine = lines[j];
          for (const ch of prevLine) {
            if (ch === '}') braceDepth++;
            if (ch === '{') braceDepth--;
          }
          if (/\btry\s*\{/.test(prevLine) && braceDepth <= 0) {
            insideTry = true;
            break;
          }
        }
        if (!insideTry) {
          smells.push({
            type: 'missing-error-handling',
            line: i + 1,
            detail: `${risky.label} without try-catch error handling`,
            severity: 'high',
          });
        }
      }
    }
  }
  return smells;
}

export function detectConsoleLogs(lines: string[]): Smell[] {
  const smells: Smell[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    if (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line)) {
      const isError = /console\.(warn|error)/.test(line);
      smells.push({
        type: 'console-log',
        line: i + 1,
        detail: `console statement found - consider using a proper logging framework`,
        severity: isError ? 'low' : 'medium',
      });
    }
  }
  return smells;
}

export function analyzeCode(content: string, filePath: string): AnalysisResult {
  const lines = content.split(/\r?\n/);

  const allSmells = [
    ...detectLongFunctions(lines),
    ...detectDeepNesting(lines),
    ...detectLongLines(lines),
    ...detectDuplicatePatterns(lines),
    ...detectMagicNumbers(lines),
    ...detectMissingErrorHandling(lines),
    ...detectConsoleLogs(lines),
  ];

  allSmells.sort((a, b) => a.line - b.line);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const smell of allSmells) {
    bySeverity[smell.severity] = (bySeverity[smell.severity] || 0) + 1;
  }

  return {
    file: filePath,
    smells: allSmells,
    summary: {
      total: allSmells.length,
      bySeverity,
    },
  };
}
