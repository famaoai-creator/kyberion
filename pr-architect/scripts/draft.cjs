#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { runSkill } = require('@agent/core');
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

    const latest = commits[0].message;
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

    // --- Governance Evidence Section ---
    const govReportPath = path.resolve(repoDir, 'work/governance-report.json');
    if (fs.existsSync(govReportPath)) {
        try {
            const report = JSON.parse(fs.readFileSync(govReportPath, 'utf8'));
            sections.push('\n## Governance Evidence (Verified by Ecosystem Architect)');
            sections.push(`**Status**: ${report.overall_status === 'compliant' ? '✅ COMPLIANT' : '❌ NON-COMPLIANT'}`);
            sections.push(`**Timestamp**: ${report.timestamp}`);
            sections.push('\n| Check | Status | Duration |');
            sections.push('| :--- | :--- | :--- |');
            report.results.forEach(r => {
                sections.push(`| ${r.name} | ${r.status === 'passed' ? '✅ PASSED' : '❌ FAILED'} | ${r.duration}s |`);
            });

            // Specific details for performance
            const perfResult = report.results.find(r => r.name === 'Performance Regression');
            if (perfResult) {
                if (perfResult.regressions && perfResult.regressions.length > 0) {
                    sections.push('\n### 📉 Performance Regressions Detected');
                    perfResult.regressions.forEach(r => {
                        sections.push(`- **${r.skill}**: ${r.lastDuration}ms (avg ${r.historicalAvg}ms, ${r.increaseRate}x slower)`);
                    });
                }
                if (perfResult.efficiency_alerts && perfResult.efficiency_alerts.length > 0) {
                    const improving = perfResult.efficiency_alerts.filter(s => s.trend === 'improving');
                    if (improving.length > 0) {
                        sections.push('\n### 📈 Performance Improvements');
                        improving.forEach(s => {
                            sections.push(`- **${s.skill}**: Score improved to ${s.efficiencyScore} (from ${s.prevScore})`);
                        });
                    }
                }
            }
        } catch (_e) { /* skip if corrupt */ }
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
