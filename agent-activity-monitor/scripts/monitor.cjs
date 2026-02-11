#!/usr/bin/env node
/**
 * agent-activity-monitor: Collects and analyzes agent activity statistics
 * from work/ logs and git history to provide ecosystem health dashboard.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project root directory',
  })
  .option('since', {
    alias: 's',
    type: 'string',
    default: '7 days ago',
    description: 'Analyze activity since this time',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

function analyzeGitActivity(dir, since) {
  const activity = { commits: 0, authors: [], filesChanged: 0, insertions: 0, deletions: 0 };
  try {
    const log = execSync(`git log --since="${since}" --no-merges --oneline`, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    activity.commits = log.trim().split('\n').filter(Boolean).length;

    const authors = execSync(`git log --since="${since}" --no-merges --format="%an"`, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    activity.authors = [...new Set(authors.trim().split('\n').filter(Boolean))];

    const shortstat = execSync(`git diff --shortstat "HEAD~${Math.min(activity.commits, 50)}" HEAD 2>/dev/null || echo "0 files"`, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const filesMatch = shortstat.match(/(\d+) files? changed/);
    const insMatch = shortstat.match(/(\d+) insertions?/);
    const delMatch = shortstat.match(/(\d+) deletions?/);
    if (filesMatch) activity.filesChanged = parseInt(filesMatch[1]);
    if (insMatch) activity.insertions = parseInt(insMatch[1]);
    if (delMatch) activity.deletions = parseInt(delMatch[1]);
  } catch (_e) { /* not a git repo */ }
  return activity;
}

function analyzeSkillUsage(dir) {
  const usage = {};
  const workDir = path.join(dir, 'work');

  // Scan work/ directory for output files
  if (fs.existsSync(workDir)) {
    function scanDir(d, depth) {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { scanDir(full, depth + 1); continue; }
          if (!e.name.endsWith('.json')) continue;
          try {
            const content = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (content.skill) {
              if (!usage[content.skill]) usage[content.skill] = { runs: 0, successes: 0, failures: 0 };
              usage[content.skill].runs++;
              if (content.status === 'success') usage[content.skill].successes++;
              else usage[content.skill].failures++;
            }
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* skip */ }
    }
    scanDir(workDir, 0);
  }

  // Also analyze recent git commits for skill-related changes
  try {
    const log = execSync('git log --oneline --since="7 days ago" --no-merges', { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = log.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const lower = line.toLowerCase();
      // Detect skill names in commit messages
      const skillMatch = lower.match(/(?:skill|run|execute)\s+(\S+)/);
      if (skillMatch && !usage[skillMatch[1]]) {
        usage[skillMatch[1]] = { runs: 1, successes: 1, failures: 0, source: 'git' };
      }
    }
  } catch (_e) { /* skip */ }

  return usage;
}

function analyzeEcosystemHealth(dir) {
  const health = { implementedSkills: 0, totalSkills: 0, testsPassing: null, lintClean: null };

  // Count skills
  try {
    const indexPath = path.join(dir, 'global_skill_index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const skills = index.skills || index;
      if (Array.isArray(skills)) {
        health.totalSkills = skills.length;
        health.implementedSkills = skills.filter(s => s.status === 'implemented').length;
      }
    }
  } catch (_e) { /* skip */ }

  // Check for recent test results
  try {
    const testResult = execSync('node tests/unit.test.cjs 2>&1 | tail -3', { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    const passMatch = testResult.match(/(\d+) passed/);
    const failMatch = testResult.match(/(\d+) failed/);
    if (passMatch) health.testsPassing = { passed: parseInt(passMatch[1]), failed: failMatch ? parseInt(failMatch[1]) : 0 };
  } catch (_e) { /* skip */ }

  return health;
}

function generateDashboard(gitActivity, skillUsage, health) {
  const topSkills = Object.entries(skillUsage)
    .sort((a, b) => b[1].runs - a[1].runs)
    .slice(0, 10)
    .map(([name, data]) => ({
      skill: name,
      ...data,
      successRate: data.runs > 0 ? Math.round((data.successes / data.runs) * 100) : 0,
    }));

  const failingSkills = Object.entries(skillUsage)
    .filter(([_n, d]) => d.failures > 0)
    .sort((a, b) => b[1].failures - a[1].failures)
    .map(([name, data]) => ({ skill: name, failures: data.failures, successRate: Math.round((data.successes / data.runs) * 100) }));

  return {
    velocity: {
      commits: gitActivity.commits,
      authors: gitActivity.authors.length,
      linesChanged: gitActivity.insertions + gitActivity.deletions,
      netLines: gitActivity.insertions - gitActivity.deletions,
    },
    skillActivity: { totalRuns: Object.values(skillUsage).reduce((s, d) => s + d.runs, 0), uniqueSkills: Object.keys(skillUsage).length, topSkills },
    failingSkills,
    ecosystem: health,
  };
}

runSkill('agent-activity-monitor', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const gitActivity = analyzeGitActivity(targetDir, argv.since);
  const skillUsage = analyzeSkillUsage(targetDir);
  const health = analyzeEcosystemHealth(targetDir);
  const dashboard = generateDashboard(gitActivity, skillUsage, health);

  const result = {
    directory: targetDir,
    analyzedSince: argv.since,
    dashboard,
    recommendations: [],
  };

  if (dashboard.failingSkills.length > 0) {
    result.recommendations.push(`${dashboard.failingSkills.length} skill(s) have failures - consider running prompt-optimizer`);
  }
  if (dashboard.velocity.commits === 0) {
    result.recommendations.push('No commits detected in the analysis period');
  }

  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
