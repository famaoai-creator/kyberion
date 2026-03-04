/**
 * Nonfunctional Architect Core Library.
 */

export interface NFRequirement {
  category: 'availability' | 'scalability' | 'security' | 'performance';
  level: 'standard' | 'high' | 'mission-critical';
  detail: string;
}

export function generateArchitecturalGuardrails(reqs: NFRequirement[]): string {
  let report = '# Non-Functional Architectural Guardrails\n\n';
  
  reqs.forEach(r => {
    report += `### [${r.category.toUpperCase()}] Level: ${r.level}\n- ${r.detail}\n\n`;
  });

  return report.trim();
}

export function validateDesign(design: string, reqs: NFRequirement[]): string[] {
  const violations: string[] = [];
  reqs.forEach(r => {
    if (r.level === 'high' && !design.toLowerCase().includes('redundant') && !design.toLowerCase().includes('ha')) {
      violations.push(`Availability violation: High availability requested but redundancy missing in design.`);
    }
  });
  return violations;
}

export function cleanRequirementText(text: string): string {
  return text.trim().replace(/[*_#]/g, '').replace(/\s+/g, ' ');
}
