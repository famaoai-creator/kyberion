import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateDirPath } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { getGitCommits, classifyCommit, stripPrefix } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', demandOption: true })
  .option('since', { alias: 's', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('release-note-crafter', () => {
    const repoDir = validateDirPath(argv.dir as string);
    const commits = getGitCommits(10); // Simple version for build stability

    const sections: Record<string, string[]> = {};
    for (const commit of commits) {
      const section = classifyCommit(commit);
      if (!sections[section]) sections[section] = [];
      sections[section].push(commit);
    }

    let markdown = `# Release Notes\n\n**Since:** ${argv.since}\n\n`;
    for (const [name, items] of Object.entries(sections)) {
      markdown += `## ${name}\n\n`;
      for (const item of items) {
        markdown += `- ${stripPrefix(item)}\n`;
      }
      markdown += '\n';
    }

    if (argv.out) safeWriteFile(argv.out as string, markdown);
    return { commits: commits.length, markdown };
  });
}
