export const ETHICS_CONTROLS = [
  {
    id: 'bias-gender-racial',
    pattern: /\b(gender|sex|male|female|race|ethnic|black|white|asian|hispanic)\b/gi,
    category: 'fairness',
    severity: 'high',
    standard: 'NIST AI RMF / EU AI Act',
    remediation: 'Implement demographic parity metrics and bias mitigation loops.'
  },
  {
    id: 'hallucination-risk',
    pattern: /\b(always|never|guarantee|100%|fact|truth)\b/gi,
    category: 'safety',
    severity: 'medium',
    standard: 'IPA AI Usage Guidelines',
    remediation: 'Add grounding (RAG) and confidence scores to AI responses.'
  },
  {
    id: 'transparency-disclosure',
    pattern: /\b(secret|internal-only|unverifiable|black-box)\b/gi,
    category: 'transparency',
    severity: 'high',
    standard: 'EU AI Act Article 13',
    remediation: 'Provide human-interpretable explanations for AI-driven decisions.'
  },
  {
    id: 'prompt-injection-risk',
    pattern: /\b(ignore previous instructions|system prompt|sudo|bypass)\b/gi,
    category: 'security',
    severity: 'critical',
    standard: 'OWASP Top 10 for LLM',
    remediation: 'Implement robust output sanitization and prompt-shielding.'
  }
];

export function auditEthics(content: string): any {
  const findings: any = { 
    compliance_score: 100,
    issues: [],
    standards_referenced: ['EU AI Act', 'NIST AI RMF', 'IPA Guidelines', 'OWASP LLM']
  };

  for (const control of ETHICS_CONTROLS) {
    const m = content.match(control.pattern);
    if (m) {
      findings.issues.push({
        id: control.id,
        category: control.category,
        severity: control.severity,
        standard: control.standard,
        matches: [...new Set(m)].slice(0, 5),
        remediation: control.remediation
      });
      // Simple scoring: Deduct based on severity
      const penalty = { critical: 40, high: 20, medium: 10, low: 5 }[control.severity] || 0;
      findings.compliance_score = Math.max(0, findings.compliance_score - penalty);
    }
  }
  return findings;
}
