export const ERROR_PATTERNS = [
  {
    regex: /timeout/i,
    category: 'timeout',
    req: 'Implement retry logic with exponential backoff.',
  },
  {
    regex: /out\s*of\s*memory|OOM/i,
    category: 'memory',
    req: 'Conduct memory profiling and add safeguards.',
  },
  {
    regex: /null\s*pointer|undefined/i,
    category: 'null-reference',
    req: 'Add defensive null checks and validation.',
  },
];

export function analyzeLogs(lines: string[]): string[] {
  const requirements = new Set<string>();
  for (const line of lines) {
    for (const pat of ERROR_PATTERNS) {
      if (pat.regex.test(line)) {
        requirements.add('REQ: ' + pat.req);
      }
    }
  }
  return Array.from(requirements);
}
