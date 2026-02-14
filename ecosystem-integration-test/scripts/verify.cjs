#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * ecosystem-integration-test: Validates interoperability between skills.
 * Checks output format compliance, wrapper usage, and knowledge protocol adherence.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Root directory of the skill ecosystem',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

function findImplementedSkills(rootDir) {
  const skills = [];
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'templates')
        continue;

      const skillMd = path.join(rootDir, entry.name, 'SKILL.md');
      const scriptsDir = path.join(rootDir, entry.name, 'scripts');
      if (!fs.existsSync(skillMd) || !fs.existsSync(scriptsDir)) continue;

      const scripts = fs
        .readdirSync(scriptsDir)
        .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
      if (scripts.length === 0) continue;

      const mdContent = fs.readFileSync(skillMd, 'utf8');
      const statusMatch = mdContent.match(/^status:\s*(.+)$/m);
      const status = statusMatch ? statusMatch[1].trim() : 'unknown';

      skills.push({
        name: entry.name,
        status,
        scripts: scripts.map((s) => path.join(scriptsDir, s)),
        skillMdPath: skillMd,
      });
    }
  } catch (_e) {
    /* skip */
  }
  return skills;
}

function checkWrapperUsage(scriptPath) {
  const content = fs.readFileSync(scriptPath, 'utf8');
  const usesWrapper =
    content.includes('skill-wrapper') ||
    content.includes('runSkill') ||
    content.includes('runSkillAsync') ||
    content.includes('runAsyncSkill');
  return { usesWrapper };
}

function checkSkillMd(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const issues = [];

  // Check frontmatter
  if (!content.startsWith('---')) {
    issues.push('Missing YAML frontmatter');
  } else {
    if (!/^name:\s*.+$/m.test(content)) issues.push('Missing name in frontmatter');
    if (!/^description:\s*.+$/m.test(content)) issues.push('Missing description in frontmatter');
    if (!/^status:\s*.+$/m.test(content)) issues.push('Missing status in frontmatter');
  }

  // Check knowledge protocol reference
  const hasKnowledgeProtocol =
    content.includes('knowledge-protocol') || content.includes('Knowledge Protocol');

  return { issues, hasKnowledgeProtocol };
}

function checkOutputSchema(scriptPath) {
  const content = fs.readFileSync(scriptPath, 'utf8');

  // Check if the script returns the standard envelope format
  const returnsProperly = content.includes('runSkill') || content.includes('runSkillAsync');
  // Check for direct console.log of non-JSON (anti-pattern)
  const rawConsoleLog = (content.match(/console\.log\(/g) || []).length;
  const jsonStringify = (content.match(/JSON\.stringify/g) || []).length;

  return {
    usesStandardEnvelope: returnsProperly,
    rawConsoleLogCount: rawConsoleLog,
    hasJsonStringify: jsonStringify > 0,
  };
}

runSkill('ecosystem-integration-test', () => {
  const rootDir = path.resolve(argv.dir);
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Directory not found: ${rootDir}`);
  }

  const skills = findImplementedSkills(rootDir);
  const results = [];
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  for (const skill of skills) {
    const checks = [];

    // Check SKILL.md
    const mdCheck = checkSkillMd(skill.skillMdPath);
    if (mdCheck.issues.length > 0) {
      checks.push({ check: 'SKILL.md', status: 'fail', issues: mdCheck.issues });
      failCount++;
    } else {
      checks.push({ check: 'SKILL.md', status: 'pass' });
      passCount++;
    }

    if (!mdCheck.hasKnowledgeProtocol) {
      checks.push({
        check: 'Knowledge Protocol',
        status: 'warn',
        message: 'No Knowledge Protocol reference in SKILL.md',
      });
      warnCount++;
    } else {
      checks.push({ check: 'Knowledge Protocol', status: 'pass' });
      passCount++;
    }

    // Check each script
    for (const script of skill.scripts) {
      const wrapperCheck = checkWrapperUsage(script);
      const schemaCheck = checkOutputSchema(script);
      const scriptName = path.basename(script);

      if (wrapperCheck.usesWrapper) {
        checks.push({ check: `${scriptName}: wrapper`, status: 'pass' });
        passCount++;
      } else {
        checks.push({
          check: `${scriptName}: wrapper`,
          status: 'fail',
          message: 'Does not use skill-wrapper',
        });
        failCount++;
      }

      if (schemaCheck.usesStandardEnvelope) {
        checks.push({ check: `${scriptName}: envelope`, status: 'pass' });
        passCount++;
      } else {
        checks.push({
          check: `${scriptName}: envelope`,
          status: 'warn',
          message: 'May not produce standard output envelope',
        });
        warnCount++;
      }
    }

    const skillStatus = checks.some((c) => c.status === 'fail')
      ? 'fail'
      : checks.some((c) => c.status === 'warn')
        ? 'warn'
        : 'pass';

    results.push({ skill: skill.name, status: skillStatus, checks });
  }

  const result = {
    directory: rootDir,
    skillsFound: skills.length,
    summary: { pass: passCount, fail: failCount, warn: warnCount },
    overallHealth:
      failCount === 0 ? (warnCount === 0 ? 'healthy' : 'minor_issues') : 'needs_attention',
    skills: results,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
