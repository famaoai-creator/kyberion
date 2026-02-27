import { execSync } from 'node:child_process';

export interface Commit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export function classifyCommit(subject: string): string {
  const lower = subject.toLowerCase();
  if (/^feat[\s(:!]/.test(lower) || lower.startsWith('feat:')) return 'Features';
  if (/^fix[\s(:!]/.test(lower) || lower.startsWith('fix:')) return 'Bug Fixes';
  if (/^refactor[\s(:!]/.test(lower) || lower.startsWith('refactor:')) return 'Refactoring';
  if (/^docs[\s(:!]/.test(lower) || lower.startsWith('docs:')) return 'Documentation';
  if (/^test[\s(:!]/.test(lower) || lower.startsWith('test:')) return 'Tests';
  if (/^chore[\s(:!]/.test(lower) || lower.startsWith('chore:')) return 'Chores';
  return 'Other';
}

export function stripPrefix(subject: string): string {
  return subject.replace(/^[a-zA-Z]+(\([^)]*\))?[!]?:\s*/, '');
}

export function getGitCommits(repoDir: string, since: string): Commit[] {
  const gitCmd = `git log --pretty=format:"%H|%s|%an|%ad" --date=short --since="${since}"`;
  const logOutput = execSync(gitCmd, { cwd: repoDir, encoding: 'utf8' });
  return logOutput
    .trim()
    .split(new RegExp('\\\\r?\\\\n'))
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash, subject, author, date] = line.split('|');
      return { hash, subject, author, date };
    });
}
