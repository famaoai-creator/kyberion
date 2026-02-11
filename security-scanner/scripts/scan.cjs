#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const isBinaryPath = require('is-binary-path');
const { runSkill } = require('@gemini/core');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

runSkill('security-scanner', () => {
    // Robust argument extraction without depending on complex parsers for the runner artifacts
    const dirIdx = process.argv.indexOf('--dir');
    const projectDir = dirIdx !== -1 ? process.argv[dirIdx + 1] : '.';
    const projectRoot = path.resolve(projectDir);

    const DANGEROUS_PATTERNS = [
        { name: 'eval_usage', regex: /eval\(.*\)/g, severity: 'high' },
        { name: 'hardcoded_secret', regex: /(API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*["'][A-Za-z0-9\-_]{16,}["']/gi, severity: 'critical' }
    ];

    const files = getAllFiles(projectRoot);
    let allFindings = [];
    let scannedCount = 0;

    files.forEach(file => {
        if (isBinaryPath(file) || file.includes('node_modules') || file.includes('.git') || file.includes('work/archive')) return;
        
        try {
            const content = fs.readFileSync(file, 'utf8');
            const relativePath = path.relative(projectRoot, file);
            
            DANGEROUS_PATTERNS.forEach(pattern => {
                const lines = content.split('\n');
                lines.forEach((line, index) => {
                    pattern.regex.lastIndex = 0; // Reset regex state
                    if (pattern.regex.test(line)) {
                        allFindings.push({
                            file: relativePath,
                            line: index + 1,
                            pattern: pattern.name,
                            severity: pattern.severity,
                            snippet: line.trim().substring(0, 100)
                        });
                    }
                });
            });
            scannedCount++;
        } catch (e) { }
    });

    return { 
        projectRoot, 
        scannedFiles: scannedCount, 
        findingCount: allFindings.length,
        findings: allFindings
    };
});
