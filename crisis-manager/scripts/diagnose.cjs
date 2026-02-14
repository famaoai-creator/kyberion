#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * crisis-manager: Rapid incident diagnostic and post-mortem preparation.
 * Correlates logs, recent commits, and system state to find root causes.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project/repository directory',
  })
  .option('log', {
    alias: 'l',
    type: 'string',
    description: 'Path to log file to analyze',
  })
  .option('since', {
    alias: 's',
    type: 'string',
    default: '24 hours ago',
    description: 'Analyze changes since this time',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

function getRecentCommits(dir, since) {
  try {
    const output = execSync(`git log --oneline --since="${since}" --no-merges`, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ...msg] = line.split(' ');
        return { hash, message: msg.join(' ') };
      });
  } catch (_e) {
    return [];
  }
}

function getRecentChangedFiles(dir, since) {
  try {
    const output = execSync(
      `git log --name-only --since="${since}" --no-merges --pretty=format:""`,
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const files = output.trim().split('\n').filter(Boolean);
    const counts = {};
    for (const f of files) {
      counts[f] = (counts[f] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([file, changes]) => ({ file, changes }));
  } catch (_e) {
    return [];
  }
}

function analyzeLogFile(logPath, maxLines) {
  if (!logPath || !fs.existsSync(logPath)) return null;

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').slice(-maxLines);

  const errors = [];
  const warnings = [];
  const patterns = {};

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.includes('error') ||
      lower.includes('exception') ||
      lower.includes('fatal') ||
      lower.includes('critical')
    ) {
      errors.push(line.trim().substring(0, 200));
      // Extract error patterns
      const match = line.match(/(?:error|exception|fatal)[\s:]+([^\n]{10,80})/i);
      if (match) {
        const pattern = match[1].trim();
        patterns[pattern] = (patterns[pattern] || 0) + 1;
      }
    } else if (lower.includes('warn')) {
      warnings.push(line.trim().substring(0, 200));
    }
  }

  const topPatterns = Object.entries(patterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, occurrences: count }));

  return {
    linesAnalyzed: lines.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    recentErrors: errors.slice(-10),
    topErrorPatterns: topPatterns,
  };
}

function correlateCommitsWithErrors(commits, logAnalysis) {
  if (!logAnalysis || commits.length === 0) return [];

  const correlations = [];
  const errorPatterns = (logAnalysis.topErrorPatterns || []).map((p) => p.pattern.toLowerCase());

  for (const commit of commits) {
    const commitMsg = commit.message.toLowerCase();
    for (const pattern of errorPatterns) {
      // Check for keyword overlap between commit messages and error patterns
      const keywords = pattern.split(/\s+/).filter((w) => w.length > 3);
      const matching = keywords.filter((k) => commitMsg.includes(k));
      if (matching.length > 0) {
        correlations.push({
          commit: commit.hash,
          commitMessage: commit.message,
          relatedPattern: pattern,
          confidence: matching.length / keywords.length,
        });
      }
    }
  }

  return correlations.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function generateIncidentReport(commits, changedFiles, logAnalysis, correlations) {
  const severity =
    logAnalysis && logAnalysis.errorCount > 50
      ? 'critical'
      : logAnalysis && logAnalysis.errorCount > 10
        ? 'high'
        : logAnalysis && logAnalysis.errorCount > 0
          ? 'medium'
          : 'low';

  const immediateActions = [];
  if (correlations.length > 0) {
    immediateActions.push(
      `Investigate commit ${correlations[0].commit}: "${correlations[0].commitMessage}" (correlated with errors)`
    );
    immediateActions.push(
      `Consider reverting recent changes to ${changedFiles
        .slice(0, 3)
        .map((f) => f.file)
        .join(', ')}`
    );
  }
  if (logAnalysis && logAnalysis.errorCount > 0) {
    immediateActions.push(
      `Top error pattern: "${logAnalysis.topErrorPatterns[0]?.pattern}" (${logAnalysis.topErrorPatterns[0]?.occurrences} occurrences)`
    );
  }
  if (immediateActions.length === 0) {
    immediateActions.push(
      'No clear root cause identified from available data. Check monitoring dashboards and service health.'
    );
  }

  return {
    severity,
    timeline: {
      recentCommits: commits.length,
      recentlyChangedFiles: changedFiles.length,
      errorsFound: logAnalysis ? logAnalysis.errorCount : 0,
    },
    immediateActions,
  };
}

runSkill('crisis-manager', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const commits = getRecentCommits(targetDir, argv.since);
  const changedFiles = getRecentChangedFiles(targetDir, argv.since);
  const logAnalysis = analyzeLogFile(argv.log, 500);
  const correlations = correlateCommitsWithErrors(commits, logAnalysis);
  const incident = generateIncidentReport(commits, changedFiles, logAnalysis, correlations);

  const result = {
    directory: targetDir,
    analyzedSince: argv.since,
    incident,
    recentCommits: commits.slice(0, 10),
    hotFiles: changedFiles.slice(0, 10),
    logAnalysis,
    correlations,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
