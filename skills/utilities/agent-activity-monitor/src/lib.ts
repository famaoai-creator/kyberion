import { execSync } from 'node:child_process';

export function getAgentActivity(
  author: string,
  since: string,
  rootDir: string
): { commits: string[]; stats: string } {
  try {
    const log = execSync(
      'git log --author="' + author + '" --since="' + since + '" --pretty=format:"%s"',
      {
        cwd: rootDir,
        encoding: 'utf8',
      }
    );
    const nl = String.fromCharCode(10);
    const commits = log.split(nl).filter(Boolean);

    const stats = execSync('git diff --shortstat HEAD@{' + since.replace(/ /g, '') + '}', {
      cwd: rootDir,
      encoding: 'utf8',
    });

    return { commits, stats };
  } catch {
    return { commits: [], stats: '' };
  }
}
