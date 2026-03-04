/**
 * Requirements Wizard Core Library.
 */

export interface Requirement {
  id: string;
  title: string;
  description: string;
  priority: 'must' | 'should' | 'could';
}

export function validateRequirements(reqs: Requirement[]): string[] {
  const issues: string[] = [];
  if (reqs.length === 0) issues.push('No requirements defined.');
  
  reqs.forEach((r, idx) => {
    if (!r.title) issues.push(`Requirement #${idx + 1} is missing a title.`);
    if (!r.description) issues.push(`Requirement "${r.title || '#' + (idx + 1)}" is missing a description.`);
  });

  return issues;
}

export function exportToMarkdown(reqs: Requirement[]): string {
  let md = '# Product Requirements Document\n\n';
  reqs.forEach(r => {
    md += `## [${r.priority.toUpperCase()}] ${r.title}\n${r.description}\n\n`;
  });
  return md.trim();
}

export function auditRequirements(reqs: Requirement[]) {
  return validateRequirements(reqs);
}
