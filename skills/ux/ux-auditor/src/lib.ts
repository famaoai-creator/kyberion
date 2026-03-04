/**
 * UX Auditor Core Library.
 */

export interface UXFinding {
  element: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

export function auditAccessibility(html: string): UXFinding[] {
  const findings: UXFinding[] = [];
  
  // Simple heuristic checks
  if (html.includes('<img') && !html.includes('alt=')) {
    findings.push({ element: 'img', issue: 'Missing alt attribute', severity: 'high' });
  }
  if (html.includes('<button') && html.includes('> <')) {
    findings.push({ element: 'button', issue: 'Empty button label', severity: 'medium' });
  }
  if (!html.includes('<html lang=')) {
    findings.push({ element: 'html', issue: 'Missing lang attribute', severity: 'medium' });
  }

  return findings;
}

export function auditHtmlContent(html: string) {
  return auditAccessibility(html);
}
