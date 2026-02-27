export const HEURISTICS: any = {
  accessibility: {
    checks: [
      {
        id: 'img-alt',
        pattern: /<img(?![^>]*alt=)/gi,
        severity: 'error',
        message: 'Image missing alt attribute',
      },
      {
        id: 'lang-attr',
        pattern: /<html(?![^>]*lang=)/gi,
        severity: 'error',
        message: 'HTML tag missing lang attribute',
      },
    ],
  },
};

export function auditHtmlContent(content: string): any[] {
  const findings: any[] = [];
  for (const check of HEURISTICS.accessibility.checks) {
    const matches = content.match(check.pattern);
    if (matches && matches.length > 0) {
      findings.push({
        id: check.id,
        severity: check.severity,
        message: check.message,
        count: matches.length,
      });
    }
  }
  return findings;
}
