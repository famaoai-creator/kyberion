#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Repository directory' })
    .option('top', { alias: 'n', type: 'number', default: 10, description: 'Number of hotspots to show' })
    .option('since', { alias: 's', type: 'string', default: '3 months ago', description: 'Analyze since' })
    .option('out', { alias: 'o', type: 'string', description: 'Output file' })
    .argv;

const repoDir = path.resolve(argv.dir);

function getChurnData(dir, since) {
    try {
        const output = execSync(
            `git log --since="${since}" --name-only --pretty=format: -- .`,
            { encoding: 'utf8', cwd: dir, timeout: 15000, stdio: 'pipe' }
        );
        const files = output.split('\n').filter(f => f.trim().length > 0);
        const churn = {};
        for (const file of files) {
            churn[file] = (churn[file] || 0) + 1;
        }
        return churn;
    } catch (_err) {
        throw new Error(`Git analysis failed: ${err.message}. Is this a git repository?`);
    }
}

function estimateComplexity(filePath, dir) {
    const fullPath = path.resolve(dir, filePath);
    if (!fs.existsSync(fullPath)) return { lines: 0, complexity: 0 };

    try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').length;

        // Simple complexity heuristics
        let complexity = 0;
        complexity += (content.match(/if\s*\(/g) || []).length;
        complexity += (content.match(/else\s/g) || []).length;
        complexity += (content.match(/for\s*\(/g) || []).length;
        complexity += (content.match(/while\s*\(/g) || []).length;
        complexity += (content.match(/switch\s*\(/g) || []).length;
        complexity += (content.match(/catch\s*\(/g) || []).length;
        complexity += (content.match(/\?\s/g) || []).length; // ternary

        return { lines, complexity };
    } catch (_e) {
        return { lines: 0, complexity: 0 };
    }
}

function calculateRiskScore(churn, complexity, lines) {
    // Risk = churn * complexity_density
    // Normalized on a 0-100 scale
    const complexityDensity = lines > 0 ? complexity / lines * 100 : 0;
    const rawScore = churn * (1 + complexityDensity);
    return Math.min(Math.round(rawScore * 10) / 10, 100);
}

runSkill('bug-predictor', () => {
    const churnData = getChurnData(repoDir, argv.since);

    // Filter to source files only
    const sourceExtensions = /\.(js|ts|cjs|mjs|py|java|go|rs|rb|php|c|cpp|h)$/;
    const sourceFiles = Object.entries(churnData)
        .filter(([file]) => sourceExtensions.test(file))
        .map(([file, churn]) => {
            const { lines, complexity } = estimateComplexity(file, repoDir);
            const riskScore = calculateRiskScore(churn, complexity, lines);
            return { file, churn, lines, complexity, riskScore };
        })
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, argv.top);

    const riskLevels = { high: 0, medium: 0, low: 0 };
    for (const f of sourceFiles) {
        if (f.riskScore >= 30) riskLevels.high++;
        else if (f.riskScore >= 10) riskLevels.medium++;
        else riskLevels.low++;
    }

    const report = {
        repository: repoDir,
        since: argv.since,
        totalFilesAnalyzed: Object.keys(churnData).length,
        hotspots: sourceFiles,
        riskSummary: riskLevels,
        recommendation: riskLevels.high > 0
            ? `${riskLevels.high} high-risk file(s) detected. Consider adding tests and refactoring.`
            : 'No critical risk hotspots found.',
    };

    if (argv.out) {
        fs.writeFileSync(argv.out, JSON.stringify(report, null, 2));
    }

    return report;
});
