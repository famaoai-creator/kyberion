#!/usr/bin/env node
/**
 * doc-sync-sentinel/scripts/check.cjs
 * High-Performance Drift Detection: Async Parallel & Optimized Lookup
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runSkillAsync } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { getAllFiles } = require('@agent/core/fs-utils');
const { safeWriteFile } = require('@agent/core/secure-io');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Directory to check' })
  .option('since', {
    alias: 's',
    type: 'string',
    default: '7 days ago',
    description: 'Check changes since',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output report file' }).argv;

const rootDir = path.resolve(argv.dir);

function getRecentChanges(dir, since) {
  try {
    const output = execSync(`git log --since="${since}" --name-only --pretty=format: -- "${dir}"`, {
      encoding: 'utf8',
      cwd: dir,
      timeout: 10000,
      stdio: 'pipe',
    });
    return [...new Set(output.split('\n').filter((f) => f.trim().length > 0))];
  } catch (_err) {
    return [];
  }
}

async function checkDriftAsync(changedSourceFiles, docFiles, dir) {
  const _drifts = [];

  // 1. Pre-calculate directory map for O(1) lookup
  const dirToSources = new Map();
  for (const f of changedSourceFiles) {
    const fullPath = path.resolve(dir, f);
    if (/\.(md|txt|rst)$/i.test(f)) continue;

    const d = path.dirname(fullPath);
    if (!dirToSources.has(d)) dirToSources.set(d, []);
    dirToSources.get(d).push(fullPath);
  }

  // 2. Parallel processing of document files
  const tasks = docFiles.map(async (docFile) => {
    const localDrifts = [];
    const docDir = path.dirname(docFile);
    const docStat = await fs.promises.stat(docFile);

    // --- Drift Check ---
    const sourcesInDir = dirToSources.get(docDir);
    if (sourcesInDir) {
      const stats = await Promise.all(
        sourcesInDir.map((s) => fs.promises.stat(s).catch(() => null))
      );
      const latestMtime = stats.reduce(
        (max, s) => (s && s.mtime > max ? s.mtime : max),
        new Date(0)
      );

      if (docStat.mtime < latestMtime) {
        localDrifts.push({
          doc: path.relative(dir, docFile),
          issue: 'Documentation drift',
          changedSources: sourcesInDir.map((s) => path.relative(dir, s)),
          severity: sourcesInDir.length > 3 ? 'high' : 'medium',
        });
      }
    }

    // --- Link Check ---
    const content = await fs.promises.readFile(docFile, 'utf8');
    const links = content.match(/\[.*?\]\(((?!http)[^)]+)\)/g) || [];
    for (const link of links) {
      const href = link.match(/\]\(([^)]+)\)/)?.[1];
      if (href) {
        const target = path.resolve(docDir, href.split('#')[0]);
        if (!fs.existsSync(target)) {
          localDrifts.push({
            doc: path.relative(dir, docFile),
            issue: 'Broken internal link',
            brokenLink: href,
            severity: 'high',
          });
        }
      }
    }
    return localDrifts;
  });

  const results = await Promise.all(tasks);
  return results.flat();
}

runSkillAsync('doc-sync-sentinel', async () => {
  const changedFiles = getRecentChanges(rootDir, argv.since);
  const docFiles = getAllFiles(rootDir, { maxDepth: 4 }).filter((f) => /\.(md|txt|rst)$/i.test(f));

  const drifts = await checkDriftAsync(changedFiles, docFiles, rootDir);

  const report = {
    directory: rootDir,
    since: argv.since,
    sourceFilesChanged: changedFiles.length,
    docFilesScanned: docFiles.length,
    driftsFound: drifts.length,
    drifts,
    summary:
      drifts.length === 0
        ? 'No documentation drift detected'
        : `Found ${drifts.length} potential drift(s) requiring attention`,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(report, null, 2));
  }

  return report;
});
