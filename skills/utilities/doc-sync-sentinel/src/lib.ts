import { execSync } from 'node:child_process';

export function getRecentChanges(dir: string, since: string): string[] {
  try {
    const output = execSync(
      'git log --since="' + since + '" --name-only --pretty=format: -- "' + dir + '"',
      {
        encoding: 'utf8',
        cwd: dir,
        stdio: 'pipe',
      }
    );
    const nl = String.fromCharCode(10);
    return [...new Set(output.split(nl).filter((f) => f.trim().length > 0))];
  } catch {
    return [];
  }
}
