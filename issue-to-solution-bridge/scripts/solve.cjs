#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('issue', { alias: 'i', type: 'string', description: 'GitHub issue number or URL' })
  .option('description', { alias: 'd', type: 'string', description: 'Issue description text' })
  .option('repo', { alias: 'r', type: 'string', description: 'Repository (owner/repo)' })
  .option('dry-run', { type: 'boolean', default: true, description: 'Analysis only, no changes' })
  .check((parsed) => {
    if (!parsed.issue && !parsed.description)
      throw new Error('Either --issue or --description is required');
    return true;
  }).argv;

const _rootDir = path.resolve(__dirname, '../..');

function fetchIssue(issueRef, repo) {
  try {
    const repoArg = repo ? `-R ${repo}` : '';
    const output = execSync(
      `gh issue view ${issueRef} ${repoArg} --json title,body,labels,assignees`,
      {
        encoding: 'utf8',
        timeout: 15000,
        stdio: 'pipe',
      }
    );
    return JSON.parse(output);
  } catch (_err) {
    throw new Error(
      `Failed to fetch issue: ${err.message}. Is 'gh' CLI installed and authenticated?`
    );
  }
}

function analyzeIssue(title, body) {
  const analysis = {
    type: 'unknown',
    severity: 'medium',
    keywords: [],
    suggestedFiles: [],
    suggestedActions: [],
  };

  const fullText = `${title} ${body}`.toLowerCase();

  // Classify issue type
  if (/bug|error|crash|fix|broken|fail/.test(fullText)) analysis.type = 'bug';
  else if (/feature|add|implement|new|enhance/.test(fullText)) analysis.type = 'feature';
  else if (/refactor|clean|improve|optimize/.test(fullText)) analysis.type = 'refactoring';
  else if (/doc|readme|comment|typo/.test(fullText)) analysis.type = 'documentation';

  // Severity
  if (/critical|urgent|blocker|production/.test(fullText)) analysis.severity = 'critical';
  else if (/minor|cosmetic|nice.to.have/.test(fullText)) analysis.severity = 'low';

  // Extract file references
  const fileRefs = fullText.match(/[\w\-\/]+\.(js|ts|py|json|md|cjs|mjs|yaml|yml)/gi);
  if (fileRefs) analysis.suggestedFiles = [...new Set(fileRefs)];

  // Suggest actions based on type
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

runSkill('issue-to-solution-bridge', () => {
  let title, body;

  if (argv.issue) {
    const issue = fetchIssue(argv.issue, argv.repo);
    title = issue.title;
    body = issue.body;
  } else {
    title = argv.description;
    body = argv.description;
  }

  const analysis = analyzeIssue(title, body || '');

  return {
    issue: argv.issue || 'custom',
    title,
    analysis,
    dry_run: argv['dry-run'],
    message: argv['dry-run']
      ? 'Dry run complete. Use --no-dry-run to execute actions.'
      : 'Analysis complete. Actions would be executed.',
  };
});
