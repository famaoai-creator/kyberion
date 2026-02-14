#!/usr/bin/env node
/**
 * security-scanner/scripts/scan.cjs
 * Pure Engine - Decoupled from patterns and standards.
 */

const _fs = require('fs');
const path = require('path');
const pathResolver = require('@agent/core/path-resolver');
const isBinaryPath = require('is-binary-path');
const { runSkillAsync } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const { getAllFilesAsync, mapAsync } = require('@agent/core/fs-utils');
const { safeReadFileAsync } = require('@agent/core/secure-io');

runSkillAsync('security-scanner', async () => {
  const argv = requireArgs(['dir']);
  const projectRoot = path.resolve(argv.dir);
  const complianceTarget = argv.compliance; // e.g. 'fisc'
  const concurrency = parseInt(argv.concurrency) || 10;

  // ... (logic for loading patterns and mappings)

  const files = await getAllFilesAsync(projectRoot);
  const allFindings = [];
  let scannedCount = 0;
  let fullContentText = '';

  // 3. Concurrency-Limited Scanning with Read Caching
  const results = await mapAsync(files, concurrency, async (file) => {
    if (
      isBinaryPath(file) ||
      file.includes('node_modules') ||
      file.includes('.git') ||
      file.includes(pathResolver.shared('archive'))
    )
      return null;

    try {
      const content = await safeReadFileAsync(file);
      const relativePath = path.relative(projectRoot, file);
      const localFindings = [];

      // Sovereignty Check: Bypassing safe IO
      if (content.includes('fs.writeFileSync') || content.includes('fs.appendFileSync')) {
        localFindings.push({
          file: relativePath,
          pattern: 'SANDBOX_BYPASS',
          severity: 'high',
          suggestion: 'Use @agent/core safeWriteFile instead of direct fs calls.',
        });
      }

      patterns.forEach((p) => {
        p.regex.lastIndex = 0;
        const matches = content.matchAll(p.regex);
        for (const _ of matches) {
          localFindings.push({
            file: relativePath,
            pattern: p.name,
            severity: p.severity,
            suggestion: p.suggestion,
          });
        }
      });
      return { content, findings: localFindings };
    } catch (_e) {
      return null;
    }
  });

  results.forEach((res) => {
    if (!res) return;
    allFindings.push(...res.findings);
    fullContentText += res.content + '\n';
    scannedCount++;
  });

  // 4. Compliance Logic (Data-Driven)
  if (complianceTarget && mappings[complianceTarget]) {
    mappings[complianceTarget].forEach((ctrl) => {
      const found = ctrl.keywords.some((k) => fullContentText.toLowerCase().includes(k));
      if (!found) {
        allFindings.push({
          file: 'Project-wide',
          pattern: `Missing Compliance Control: ${ctrl.name}`,
          severity: ctrl.severity,
          suggestion: `${complianceTarget.toUpperCase()} standard requires ${ctrl.name}.`,
        });
      }
    });
  }

  return {
    projectRoot,
    scannedFiles: scannedCount,
    findingCount: allFindings.length,
    findings: allFindings,
  };
});
