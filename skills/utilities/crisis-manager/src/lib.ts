export function analyzeLogLines(lines: string[]): any {
  const errors: string[] = [];
  const patterns: Record<string, number> = {};

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) {
      errors.push(line.trim().substring(0, 100));
      const regex = new RegExp('(?:error|exception|fatal)[\\\\s:]+([^\\\\n]{5,50})', 'i');
      const match = line.match(regex);
      if (match) {
        const p = match[1].trim();
        patterns[p] = (patterns[p] || 0) + 1;
      }
    }
  }

  return {
    errorCount: errors.length,
    topPatterns: Object.entries(patterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
  };
}
