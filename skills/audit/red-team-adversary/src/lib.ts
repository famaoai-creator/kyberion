export const ATTACK_VECTORS = [
  {
    id: 'hardcoded-secrets',
    pattern: /(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]{8,}/gi,
    severity: 'critical',
  },
  {
    id: 'sql-injection',
    pattern: /(?:query|execute|raw)\s*\(\s*[`'"].*\$\{|(?:\+\s*req\.|concat)/gi,
    severity: 'critical',
  },
];

export function staticAnalysis(content: string, fileName: string): any[] {
  const vulnerabilities: any[] = [];
  for (const vector of ATTACK_VECTORS) {
    const matches = content.match(vector.pattern);
    if (matches) {
      vulnerabilities.push({
        file: fileName,
        vector: vector.id,
        severity: vector.severity,
        occurrences: matches.length,
      });
    }
  }
  return vulnerabilities;
}
