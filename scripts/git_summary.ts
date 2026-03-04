/**
 * scripts/git_summary.ts
 * A lightweight tool to summarize recent activity without consuming large context.
 * Dynamic Name Resolution: Fetches author from environment or identity files.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getAuthor(): string {
  // 1. Check for Sudo/Environment
  if (process.env.GIT_AUTHOR_NAME) return process.env.GIT_AUTHOR_NAME;
  
  // 2. Try to load from Sovereign Identity
  try {
    const idPath = path.join(process.cwd(), 'knowledge/personal/my-identity.json');
    if (fs.existsSync(idPath)) {
      const id = JSON.parse(fs.readFileSync(idPath, 'utf8'));
      if (id.name) return id.name;
    }
  } catch (err) {}

  // 3. Fallback to OS user
  try {
    return execSync('whoami', { encoding: 'utf8' }).trim();
  } catch (err) {
    return 'sovereign';
  }
}

const author = process.argv[2] || getAuthor();
const since = process.argv[3] || '24 hours ago';

try {
  console.log(`--- Activity Summary for [${author}] since [${since}] ---`);
  
  const log = execSync(
    `git log --author="${author}" --since="${since}" --pretty=format:"- %s (%h)"`,
    { encoding: 'utf8' }
  );
  
  if (!log) {
    console.log('No recent activity found.');
  } else {
    console.log(log);
    
    console.log('\n--- Stats ---');
    // Using relative ref for diff
    const stats = execSync(`git diff --shortstat HEAD@{"${since.replace(/ /g, '')}"}`, {
      encoding: 'utf8',
    });
    console.log(stats.trim());
  }
} catch (err: any) {
  console.error(`Failed to fetch activity: ${err.message}`);
}
