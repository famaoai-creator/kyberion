export const HEURISTICS: any = {
  web: {
    checks: [
      {
        id: 'img-alt',
        pattern: /<img(?![^>]*alt=)/gi,
        severity: 'error',
        message: 'Web (WCAG): Image missing alt attribute. Crucial for screen readers.',
      },
      {
        id: 'lang-attr',
        pattern: /<html(?![^>]*lang=)/gi,
        severity: 'error',
        message: 'Web (WCAG): HTML tag missing lang attribute. Impacts accessibility.',
      },
      {
        id: 'viewport-meta',
        pattern: /<meta[^>]*name=["']viewport["']/gi,
        severity: 'warning',
        message: 'Web: Missing responsive viewport meta tag. Required for mobile usability.',
      },
    ],
  },
  mobile: {
    checks: [
      {
        id: 'ios-tap-target',
        pattern: /style=["'][^"']*width:\s*(?:[1-3]\d|4[0-3])px/gi,
        severity: 'warning',
        message: 'iOS (HIG): Tap target width might be below 44px. Recommended minimum.',
      },
      {
        id: 'android-touch-target',
        pattern: /style=["'][^"']*height:\s*(?:[1-3]\d|4[0-7])px/gi,
        severity: 'warning',
        message: 'Android (Material): Touch target height might be below 48dp. Recommended minimum.',
      },
    ],
  },
};

export function auditHtmlContent(content: string): any[] {
  const findings: any[] = [];
  
  // Audit Web Heuristics
  for (const check of HEURISTICS.web.checks) {
    const matches = content.match(check.pattern);
    if (matches && matches.length > 0) {
      findings.push({
        id: check.id,
        platform: 'Web',
        severity: check.severity,
        message: check.message,
        count: matches.length,
      });
    }
  }

  // Audit Mobile Heuristics
  for (const check of HEURISTICS.mobile.checks) {
    const matches = content.match(check.pattern);
    if (matches && matches.length > 0) {
      findings.push({
        id: check.id,
        platform: 'Mobile',
        severity: check.severity,
        message: check.message,
        count: matches.length,
      });
    }
  }

  return findings;
}
