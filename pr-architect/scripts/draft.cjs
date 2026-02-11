#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Git repository directory' })
    .argv;

const repoDir = path.resolve(argv.dir);

function getRecentCommits(dir) {
    try {
        const output = execSync('git log --oneline -20', {
            encoding: 'utf8',
            cwd: dir,
            timeout: 15000,
            stdio: 'pipe',
        });
        return output
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => {
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx === -1) return { hash: line.trim(), message: '' };
                return {
                    hash: line.substring(0, spaceIdx),
                    message: line.substring(spaceIdx + 1).trim(),
                };
            });
    } catch (err) {
        throw new Error(`Failed to read git log: ${err.message}. Is this a git repository?`);
    }
}

function getDiffStat(dir) {
    try {
        const output = execSync('git diff --stat HEAD~1', {
            encoding: 'utf8',
            cwd: dir,
            timeout: 15000,
            stdio: 'pipe',
        });
        const lines = output.split('\n').filter(line => line.trim().length > 0);
        const changedFiles = [];
        for (const line of lines) {
            // Lines look like: " file.js | 5 ++---"
            const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
            if (match) {
                changedFiles.push({
                    file: match[1].trim(),
                    changes: parseInt(match[2], 10),
                });
            }
        }
        return changedFiles;
    } catch (_err) {
        // If HEAD~1 doesn't exist (initial commit), return empty
        return [];
    }
}

function categorizeChanges(changedFiles) {
    const categories = {
        features: [],
        fixes: [],
        tests: [],
        docs: [],
        config: [],
        other: [],
    };

    for (const { file } of changedFiles) {
        const lower = file.toLowerCase();
        if (/test|spec|__tests__/.test(lower)) {
            categories.tests.push(file);
        } else if (/readme|docs?\/|\.md$|changelog/i.test(lower)) {
            categories.docs.push(file);
        } else if (/\.config\.|\.json$|\.ya?ml$|\.toml$|\.ini$|\.env/.test(lower)) {
            categories.config.push(file);
        } else {
            categories.other.push(file);
        }
    }

    return categories;
}

function generateTitle(commits) {
    if (commits.length === 0) return 'Update repository';

    // Use the most recent commit message as the base for the title
    const latest = commits[0].message;

    // If it already looks like a conventional commit, use it
    if (/^(feat|fix|chore|docs|refactor|test|style|perf|ci|build)(\(.+\))?:/.test(latest)) {
        return latest;
    }

    return latest.length > 72 ? latest.substring(0, 69) + '...' : latest;
}

function generateDescription(commits, changedFiles, categories) {
    const sections = [];

    sections.push('## Summary');
    if (commits.length > 0) {
        sections.push(`This PR includes ${commits.length} commit(s) affecting ${changedFiles.length} file(s).`);
    }

    if (categories.features.length > 0 || categories.other.length > 0) {
        sections.push('\n## Changes');
        const allChanges = [...categories.features, ...categories.other];
        for (const file of allChanges) {
            sections.push(`- \`${file}\``);
        }
    }

    if (categories.tests.length > 0) {
        sections.push('\n## Tests');
        for (const file of categories.tests) {
            sections.push(`- \`${file}\``);
        }
    }

    if (categories.docs.length > 0) {
        sections.push('\n## Documentation');
        for (const file of categories.docs) {
            sections.push(`- \`${file}\``);
        }
    }

    if (categories.config.length > 0) {
        sections.push('\n## Configuration');
        for (const file of categories.config) {
            sections.push(`- \`${file}\``);
        }
    }

    sections.push('\n## Commits');
    for (const commit of commits.slice(0, 10)) {
        sections.push(`- ${commit.hash} ${commit.message}`);
    }
    if (commits.length > 10) {
        sections.push(`- ... and ${commits.length - 10} more`);
    }

    return sections.join('\n');
}

runSkill('pr-architect', () => {
    const commits = getRecentCommits(repoDir);
    const changedFiles = getDiffStat(repoDir);
    const categories = categorizeChanges(changedFiles);
    const title = generateTitle(commits);
    const description = generateDescription(commits, changedFiles, categories);

    return {
        title,
        description,
        changedFiles: changedFiles.map(f => f.file),
        commits: commits.map(c => `${c.hash} ${c.message}`),
        suggestedReviewers: [],
    };
});
