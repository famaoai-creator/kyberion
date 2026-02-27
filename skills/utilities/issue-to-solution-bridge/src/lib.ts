import { safeExec } from '@agent/core/secure-io';

export interface IssueAnalysis {
  type: string;
  severity: string;
  keywords: string[];
  suggestedFiles: string[];
  suggestedActions: string[];
}

export function analyzeIssue(title: string, body: string): IssueAnalysis {
  const analysis: IssueAnalysis = {
    type: 'unknown',
    severity: 'medium',
    keywords: [],
    suggestedFiles: [],
    suggestedActions: [],
  };

  const fullText = `${title} ${body}`.toLowerCase();

  if (/bug|error|crash|fix|broken|fail/.test(fullText)) analysis.type = 'bug';
  else if (/feature|add|implement|new|enhance/.test(fullText)) analysis.type = 'feature';
  else if (/refactor|clean|improve|optimize/.test(fullText)) analysis.type = 'refactoring';
  else if (/doc|readme|comment|typo/.test(fullText)) analysis.type = 'documentation';

  if (/critical|urgent|blocker|production/.test(fullText)) analysis.severity = 'critical';
  else if (/minor|cosmetic|nice.to.have/.test(fullText)) analysis.severity = 'low';

  const fileRefs = fullText.match(/[\w\-\/]+\.(js|ts|py|json|md|cjs|mjs|yaml|yml)/gi);
  if (fileRefs) analysis.suggestedFiles = [...new Set(fileRefs)];

  switch (analysis.type) {
    case 'bug':
      analysis.suggestedActions = [
        'Reproduce the issue',
        'Identify root cause with codebase-mapper',
        'Write regression test with test-genie',
        'Implement fix',
        'Run security-scanner',
      ];
      break;
    case 'feature':
      analysis.suggestedActions = [
        'Define acceptance criteria',
        'Map affected modules with codebase-mapper',
        'Create implementation plan',
        'Write tests first (TDD) with test-genie',
        'Implement feature',
      ];
      break;
    case 'refactoring':
      analysis.suggestedActions = [
        'Analyze current code with local-reviewer',
        'Identify refactoring targets',
        'Ensure test coverage',
        'Execute refactoring',
        'Verify no regressions',
      ];
      break;
    default:
      analysis.suggestedActions = ['Analyze issue', 'Plan implementation', 'Execute', 'Verify'];
  }

  return analysis;
}

export function fetchIssueFromGH(issueRef: string, repo?: string): { title: string; body: string } {
  const args = ['issue', 'view', issueRef];
  if (repo) {
    args.push('-R', repo);
  }
  args.push('--json', 'title,body');

  const output = safeExec('gh', args);
  return JSON.parse(output);
}
