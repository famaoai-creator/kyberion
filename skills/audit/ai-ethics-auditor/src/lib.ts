export const BIAS_INDICATORS = [
  { pattern: /\b(gender|sex|male|female|man|woman)\b/gi, category: 'gender', severity: 'medium' },
  {
    pattern: /\b(race|ethnic|black|white|asian|hispanic|latino)\b/gi,
    category: 'racial',
    severity: 'high',
  },
];

export function auditEthics(content: string): any {
  const findings: any = { bias: [] };
  for (const rule of BIAS_INDICATORS) {
    const m = content.match(rule.pattern);
    if (m) {
      findings.bias.push({
        category: rule.category,
        severity: rule.severity,
        matches: [...new Set(m)].slice(0, 5),
      });
    }
  }
  return findings;
}
