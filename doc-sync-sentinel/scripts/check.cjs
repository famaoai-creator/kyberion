#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs()
    .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Directory to check' })
    .option('since', { alias: 's', type: 'string', default: '7 days ago', description: 'Check changes since' })
    .option('out', { alias: 'o', type: 'string', description: 'Output report file' })
    .argv;

const rootDir = path.resolve(argv.dir);

function getRecentChanges(dir, since) {
    try {
        const output = execSync(
            `git log --since="${since}" --name-only --pretty=format: -- "${dir}"`,
            { encoding: 'utf8', cwd: dir, timeout: 10000, stdio: 'pipe' }
        );
        const files = output.split('\n').filter(f => f.trim().length > 0);
        return [...new Set(files)];
    } catch (_err) {
        return [];
    }
}

function findDocFiles(dir) {
    const docFiles = [];
    const _patterns = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs'];

    function walk(d, depth) {
        if (depth > 3) return;
        try {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                const fullPath = path.join(d, entry.name);
                if (entry.isFile() && /\.(md|txt|rst)$/i.test(entry.name)) {
                    docFiles.push(fullPath);
                } else if (entry.isDirectory() && depth < 3) {
                    walk(fullPath, depth + 1);
                }
            }
        } catch (_e) { /* ignore permission errors */ }
    }

    walk(dir, 0);
    return docFiles;
}

function checkDrift(changedSourceFiles, docFiles, dir) {
    const drifts = [];

    // Map changed source files to their parent directories
    const changedDirs = new Set(changedSourceFiles.map(f => path.dirname(path.resolve(dir, f))));

    for (const docFile of docFiles) {
        const docDir = path.dirname(docFile);
        const docContent = fs.readFileSync(docFile, 'utf8');
        const docStat = fs.statSync(docFile);

        // Check if any source files in the same directory were changed
        if (changedDirs.has(docDir)) {
            const sourcesInDir = changedSourceFiles.filter(f =>
                path.dirname(path.resolve(dir, f)) === docDir &&
                !/\.(md|txt|rst)$/i.test(f)
            );

            if (sourcesInDir.length > 0) {
                // Check if doc was updated after the source changes
                const lastSourceChange = sourcesInDir.reduce((latest, f) => {
                    try {
                        const stat = fs.statSync(path.resolve(dir, f));
                        return stat.mtime > latest ? stat.mtime : latest;
                    } catch (_e) { return latest; }
                }, new Date(0));

                if (docStat.mtime < lastSourceChange) {
                    drifts.push({
                        doc: path.relative(dir, docFile),
                        changedSources: sourcesInDir,
                        docLastModified: docStat.mtime.toISOString(),
                        severity: sourcesInDir.length > 3 ? 'high' : 'medium',
                    });
                }
            }
        }

        // Check for broken internal links
        const links = docContent.match(/\[.*?\]\(((?!http)[^)]+)\)/g) || [];
        for (const link of links) {
            const href = link.match(/\]\(([^)]+)\)/)?.[1];
            if (href) {
                const target = path.resolve(docDir, href.split('#')[0]);
                if (!fs.existsSync(target)) {
                    drifts.push({
                        doc: path.relative(dir, docFile),
                        brokenLink: href,
                        severity: 'high',
                    });
                }
            }
        }
    }

    return drifts;
}

runSkill('doc-sync-sentinel', () => {
    const changedFiles = getRecentChanges(rootDir, argv.since);
    const docFiles = findDocFiles(rootDir);
    const drifts = checkDrift(changedFiles, docFiles, rootDir);

    const report = {
        directory: rootDir,
        since: argv.since,
        sourceFilesChanged: changedFiles.length,
        docFilesScanned: docFiles.length,
        driftsFound: drifts.length,
        drifts,
        summary: drifts.length === 0
            ? 'No documentation drift detected'
            : `Found ${drifts.length} potential drift(s) requiring attention`,
    };

    if (argv.out) {
        fs.writeFileSync(argv.out, JSON.stringify(report, null, 2));
    }

    return report;
});
