#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { validateDirPath, requireArgs } = require('@agent/core/validators');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    describe: 'Git repository path',
    demandOption: true,
  })
  .option('since', {
    alias: 's',
    type: 'string',
    describe: 'Date or tag to start from',
    demandOption: true,
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    describe: 'Output file path for release notes',
  }).argv;

/**
 * Map a conventional commit prefix to a section name.
 * @param {string} subject - The commit subject line
 * @returns {string} Section name
 */
function classifyCommit(subject) {
  const lower = subject.toLowerCase();
  if (/^feat[\s(:!]/.test(lower) || lower.startsWith('feat:')) return 'Features';
  if (/^fix[\s(:!]/.test(lower) || lower.startsWith('fix:')) return 'Bug Fixes';
  if (/^refactor[\s(:!]/.test(lower) || lower.startsWith('refactor:')) return 'Refactoring';
  if (/^docs[\s(:!]/.test(lower) || lower.startsWith('docs:')) return 'Documentation';
  if (/^test[\s(:!]/.test(lower) || lower.startsWith('test:')) return 'Tests';
  if (/^chore[\s(:!]/.test(lower) || lower.startsWith('chore:')) return 'Chores';
  if (/^perf[\s(:!]/.test(lower) || lower.startsWith('perf:')) return 'Performance';
  if (/^ci[\s(:!]/.test(lower) || lower.startsWith('ci:')) return 'CI';
  if (/^style[\s(:!]/.test(lower) || lower.startsWith('style:')) return 'Style';
  if (/^build[\s(:!]/.test(lower) || lower.startsWith('build:')) return 'Build';
  return 'Other';
}

/**
 * Strip the conventional commit prefix from a subject line.
 * @param {string} subject - The commit subject
 * @returns {string} Clean description
 */
function stripPrefix(subject) {
  return subject.replace(/^[a-zA-Z]+(\([^)]*\))?[!]?:\s*/, '');
}

runSkill('release-note-crafter', () => {
  requireArgs(argv, ['dir', 'since']);
  const repoDir = validateDirPath(argv.dir, 'git repository');

  // Verify it is a git repository
  const gitDir = path.join(repoDir, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${repoDir}`);
  }

  // Fetch git log
  const gitCmd = `git log --pretty=format:"%H|%s|%an|%ad" --date=short --since="${argv.since}"`;
  let logOutput;
  try {
    logOutput = execSync(gitCmd, { cwd: repoDir, encoding: 'utf8', timeout: 30000 });
  } catch (err) {
    throw new Error(`Failed to run git log: ${err.message}`);
  }

  const lines = logOutput
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  const commits = lines.map((line) => {
    const parts = line.split('|');
    return {
      hash: parts[0] || '',
      subject: parts[1] || '',
      author: parts[2] || '',
      date: parts[3] || '',
    };
  });

  // Group by type
  const sections = {};
  for (const commit of commits) {
    const section = classifyCommit(commit.subject);
    if (!sections[section]) sections[section] = [];
    sections[section].push(commit);
  }

  // Generate markdown
  const sectionOrder = [
    'Features',
    'Bug Fixes',
    'Performance',
    'Refactoring',
    'Documentation',
    'Tests',
    'CI',
    'Build',
    'Style',
    'Chores',
    'Other',
  ];

  let markdown = `# Release Notes\n\n`;
  markdown += `**Since:** ${argv.since}\n`;
  markdown += `**Generated:** ${new Date().toISOString().split('T')[0]}\n`;
  markdown += `**Total Commits:** ${commits.length}\n\n`;

  const sectionCounts = {};
  for (const sectionName of sectionOrder) {
    const items = sections[sectionName];
    if (!items || items.length === 0) continue;
    sectionCounts[sectionName] = items.length;

    markdown += `## ${sectionName}\n\n`;
    for (const commit of items) {
      const desc = stripPrefix(commit.subject);
      markdown += `- ${desc} (${commit.hash.substring(0, 7)}) - ${commit.author}\n`;
    }
    markdown += '\n';
  }

  // Write output file if requested
  if (argv.out) {
    const outPath = path.resolve(argv.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    safeWriteFile(outPath, markdown, 'utf8');
  }

  return {
    commits: commits.length,
    sections: sectionCounts,
    markdown,
  };
});
