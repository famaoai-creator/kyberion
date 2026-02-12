#!/usr/bin/env node
/**
 * security-scanner/scripts/scan.cjs
 * Pure Engine - Decoupled from patterns and standards.
 */

const fs = require('fs');
const path = require('path');
const isBinaryPath = require('is-binary-path');
const { runSkill } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

runSkill('security-scanner', () => {
    const argv = requireArgs(['dir']);
    const projectRoot = path.resolve(argv.dir);
    const complianceTarget = argv.compliance; // e.g. 'fisc'

    // 1. Load Knowledge (Patterns)
    const patternsPath = path.resolve(__dirname, '../../knowledge/skills/security-scanner/vulnerability-patterns.json');
    const patterns = JSON.parse(fs.readFileSync(patternsPath, 'utf8')).map(p => ({
        ...p,
        regex: new RegExp(p.regex, 'gi')
    }));

    // 2. Load Compliance Mapping
    const mappingPath = path.resolve(__dirname, '../../knowledge/skills/security-scanner/compliance-mapping.json');
    const mappings = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

    const files = getAllFiles(projectRoot);
    const allFindings = [];
    let scannedCount = 0;
    let fullContentText = "";

    // 3. Main Scanning Loop
    files.forEach(file => {
        if (isBinaryPath(file) || file.includes('node_modules') || file.includes('.git') || file.includes('work/archive')) return;
        
        try {
            const content = fs.readFileSync(file, 'utf8');
            fullContentText += content + "\n";
            const relativePath = path.relative(projectRoot, file);
            
            patterns.forEach(p => {
                p.regex.lastIndex = 0;
                const matches = content.matchAll(p.regex);
                for (const _ of matches) {
                    allFindings.push({
                        file: relativePath,
                        pattern: p.name,
                        severity: p.severity,
                        suggestion: p.suggestion
                    });
                }
            });
            scannedCount++;
        } catch (e) { }
    });

    // 4. Compliance Logic (Data-Driven)
    if (complianceTarget && mappings[complianceTarget]) {
        mappings[complianceTarget].forEach(ctrl => {
            const found = ctrl.keywords.some(k => fullContentText.toLowerCase().includes(k));
            if (!found) {
                allFindings.push({
                    file: 'Project-wide',
                    pattern: `Missing Compliance Control: ${ctrl.name}`,
                    severity: ctrl.severity,
                    suggestion: `${complianceTarget.toUpperCase()} standard requires ${ctrl.name}.`
                });
            }
        });
    }

    return { 
        projectRoot, 
        scannedFiles: scannedCount, 
        findingCount: allFindings.length,
        findings: allFindings
    };
});
