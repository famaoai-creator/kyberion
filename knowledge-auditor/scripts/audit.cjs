#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const { scanForConfidentialMarkers, detectTier } = require('../../scripts/lib/tier-guard.cjs');

const MAX_DEPTH = 5;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    demandOption: true,
    describe: 'Path to knowledge directory to scan',
  })
  .check((parsed) => {
    const resolved = path.resolve(parsed.dir);
    if (!fs.existsSync(resolved)) {
      throw new Error('Directory not found: ' + resolved);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('Path is not a directory: ' + resolved);
    }
    return true;
  })
  .strict()
  .help()
  .argv;

/**
 * Classify a file by knowledge tier and detect markers.
 */
function classifyFile(filePath) {
  const tier = detectTier(filePath);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return { filePath, tier, markers: { hasMarkers: false, markers: [] }, error: 'unreadable' };
  }

  const markers = scanForConfidentialMarkers(content);
  return { filePath, tier, markers };
}

/**
 * Detect violations: confidential markers in public-tier files.
 */
function detectViolations(classifications) {
  const violations = [];

  for (const item of classifications) {
    if (item.error) {
      continue;
    }

    // Violation: public-tier file contains confidential markers
    if (item.tier === 'public' && item.markers.hasMarkers) {
      violations.push({
        file: item.filePath,
        tier: item.tier,
        issue: 'Confidential markers found in public-tier file',
        markers: item.markers.markers,
        severity: 'high',
      });
    }

    // Violation: internal/public file with secrets patterns
    if (item.tier !== 'personal' && item.tier !== 'confidential') {
      const hasSecrets = item.markers.markers.some(m =>
        m === 'API[_-]?KEY' || m === 'PASSWORD' || m === 'TOKEN' ||
        m.includes('Bearer')
      );
      if (hasSecrets) {
        violations.push({
          file: item.filePath,
          tier: item.tier,
          issue: 'Potential secrets detected outside confidential/personal tier',
          markers: item.markers.markers,
          severity: 'critical',
        });
      }
    }
  }

  return violations;
}

/**
 * Generate recommendations based on audit findings.
 */
function generateRecommendations(tiers, violations) {
  const recommendations = [];

  if (violations.length > 0) {
    recommendations.push('Review and remediate ' + violations.length + ' tier violation(s) immediately');
  }

  const criticalViolations = violations.filter(v => v.severity === 'critical');
  if (criticalViolations.length > 0) {
    recommendations.push('URGENT: ' + criticalViolations.length + ' file(s) contain potential secrets in public/internal tiers');
  }

  if (tiers.confidential === 0 && tiers.personal === 0) {
    recommendations.push('No confidential or personal tier files found - verify tier structure is correct');
  }

  if (tiers.public > 0 && violations.length === 0) {
    recommendations.push('All public-tier files are clean of confidential markers');
  }

  if (tiers.public + tiers.internal + tiers.confidential + tiers.personal === 0) {
    recommendations.push('No scannable files found in the directory');
  }

  return recommendations;
}

runSkill('knowledge-auditor', () => {
  const targetDir = path.resolve(argv.dir);
  const files = getAllFiles(targetDir, { maxDepth: MAX_DEPTH });

  const classifications = files
    .filter(f => {
      try {
        return fs.statSync(f).size <= MAX_FILE_SIZE;
      } catch (_e) { return false; }
    })
    .map(f => classifyFile(f));

  const tiers = { public: 0, internal: 0, confidential: 0, personal: 0 };
  for (const item of classifications) {
    if (item.tier === 'personal') {
      tiers.personal++;
    } else if (item.tier === 'confidential') {
      tiers.confidential++;
    } else {
      const rel = path.relative(targetDir, item.filePath);
      if (rel.includes('internal') || rel.includes('private')) {
        tiers.internal++;
        item.tier = 'internal';
      } else {
        tiers.public++;
      }
    }
  }

  const violations = detectViolations(classifications);
  const recommendations = generateRecommendations(tiers, violations);

  return {
    totalFiles: files.length,
    scanRoot: targetDir,
    maxDepth: MAX_DEPTH,
    maxFileSize: MAX_FILE_SIZE,
    tiers,
    violations,
    recommendations,
  };
});