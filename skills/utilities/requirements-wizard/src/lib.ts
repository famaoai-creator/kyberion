export interface AuditResult {
  criterion: string;
  status: 'passed' | 'missing';
  suggestion: string | null;
}

export function auditRequirements(
  adf: any,
  checklist: string[]
): { score: number; results: AuditResult[] } {
  const contentText = JSON.stringify(adf).toLowerCase();
  const results: AuditResult[] = checklist.map((item) => {
    const found = contentText.includes(item.toLowerCase().split(' ')[0]);
    return {
      criterion: item,
      status: found ? 'passed' : 'missing',
      suggestion: found ? null : 'Requirement ' + item + ' is not clearly defined in ADF.',
    };
  });

  const score = Math.round(
    (results.filter((r) => r.status === 'passed').length / results.length) * 100
  );

  return { score, results };
}
