/**
 * Cloud Waste Hunter Core Library.
 * Statically analyzes cloud configurations for wasteful patterns.
 */

export interface WasteFinding {
  file: string;
  type: 'oversized-instance' | 'inefficient-image' | 'missing-autoscaling';
  detail: string;
  impact: 'high' | 'medium';
}

/**
 * Checks for oversized EC2 instances or similar wasteful sizing.
 */
export function checkOversizedInstances(content: string, filePath: string): WasteFinding[] {
  const findings: WasteFinding[] = [];
  const oversizedPatterns = [
    { regex: /instance_type\s*=\s*['"].*\.[4-9]xlarge['"]/i, label: 'oversized-instance' as const, impact: 'high' as const },
    { regex: /instance_type\s*=\s*['"].*\.24xlarge['"]/i, label: 'oversized-instance' as const, impact: 'high' as const },
  ];

  oversizedPatterns.forEach(p => {
    if (p.regex.test(content)) {
      findings.push({
        file: filePath,
        type: p.label,
        detail: `Expensive instance type detected in ${filePath}`,
        impact: p.impact
      });
    }
  });

  return findings;
}

/**
 * Checks for inefficient base images in Dockerfiles.
 */
export function checkDockerfileWaste(content: string, filePath: string): WasteFinding[] {
  const findings: WasteFinding[] = [];
  if (content.includes('FROM ubuntu') || content.includes('FROM debian')) {
    findings.push({
      file: filePath,
      type: 'inefficient-image',
      detail: 'Heavier base image detected. Consider alpine or slim variants to reduce storage and build time.',
      impact: 'medium'
    });
  }
  return findings;
}

export function calculateWasteScore(findings: WasteFinding[]): number {
  let score = 0;
  findings.forEach(f => {
    score += f.impact === 'high' ? 25 : 10;
  });
  return Math.min(100, score);
}
