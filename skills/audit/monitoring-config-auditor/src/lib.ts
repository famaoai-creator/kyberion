export const MONITORING_CHECKS = [
  {
    id: 'health-endpoint',
    patterns: ['/health', '/healthz', '/ready'],
    label: 'Health check endpoint',
  },
  { id: 'metrics-endpoint', patterns: ['/metrics', 'prometheus'], label: 'Metrics endpoint' },
];

export function auditMonitoringContent(content: string): any[] {
  const results: any[] = [];
  for (const check of MONITORING_CHECKS) {
    const found = check.patterns.some((p) => content.toLowerCase().includes(p.toLowerCase()));
    results.push({
      id: check.id,
      label: check.label,
      status: found ? 'configured' : 'missing',
    });
  }
  return results;
}
