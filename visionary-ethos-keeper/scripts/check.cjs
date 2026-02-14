#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * visionary-ethos-keeper: Ensures decisions and proposals align with
 * company mission, values, and ethical guidelines.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to proposal/decision document or JSON',
  })
  .option('values', {
    alias: 'v',
    type: 'string',
    description: 'Path to company values/mission JSON',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

const DEFAULT_VALUES = {
  mission: 'Deliver value through technology with integrity and innovation',
  core_values: [
    {
      name: 'User First',
      description: 'Prioritize user needs and experience above all',
      keywords: ['user', 'customer', 'experience', 'ux', 'accessibility', 'usability'],
    },
    {
      name: 'Transparency',
      description: 'Operate with openness and honest communication',
      keywords: ['transparent', 'open', 'honest', 'clear', 'communicate', 'visibility'],
    },
    {
      name: 'Innovation',
      description: 'Embrace creative solutions and continuous improvement',
      keywords: ['innovat', 'creative', 'improve', 'modern', 'cutting-edge', 'novel'],
    },
    {
      name: 'Sustainability',
      description: 'Build for long-term impact, not short-term gains',
      keywords: ['sustain', 'long-term', 'maintain', 'durable', 'scalab', 'future'],
    },
    {
      name: 'Diversity & Inclusion',
      description: 'Foster diverse perspectives and inclusive practices',
      keywords: ['divers', 'inclus', 'equit', 'access', 'fair', 'bias'],
    },
    {
      name: 'Data Privacy',
      description: 'Protect user data and respect privacy',
      keywords: ['privacy', 'data protection', 'gdpr', 'consent', 'secure', 'encrypt'],
    },
    {
      name: 'Quality',
      description: 'Deliver high-quality, reliable solutions',
      keywords: ['quality', 'reliable', 'robust', 'test', 'standard', 'best practice'],
    },
  ],
  ethical_guidelines: [
    {
      rule: 'No dark patterns',
      description: 'Never use deceptive UX patterns',
      red_flags: ['dark pattern', 'trick', 'deceiv', 'manipulat', 'hidden fee', 'forced'],
    },
    {
      rule: 'No bias amplification',
      description: 'Avoid amplifying societal biases',
      red_flags: ['discriminat', 'biased', 'unfair', 'stereotype', 'exclud'],
    },
    {
      rule: 'Environmental responsibility',
      description: 'Consider environmental impact',
      red_flags: ['wasteful', 'inefficient', 'excessive resource', 'overprovisioned'],
    },
    {
      rule: 'Fair labor practices',
      description: 'Respect worker rights and fair compensation',
      red_flags: ['overwork', 'unpaid', 'exploit', 'crunch', 'burnout'],
    },
  ],
};

function loadValues(valuesPath) {
  if (valuesPath && fs.existsSync(valuesPath)) {
    const custom = JSON.parse(fs.readFileSync(valuesPath, 'utf8'));
    return { ...DEFAULT_VALUES, ...custom };
  }
  return DEFAULT_VALUES;
}

function analyzeAlignment(content, values) {
  const lower = content.toLowerCase();
  const alignment = [];

  for (const value of values.core_values) {
    const matches = value.keywords.filter((k) => lower.includes(k));
    const score = matches.length > 0 ? Math.min(100, matches.length * 30) : 0;
    alignment.push({
      value: value.name,
      description: value.description,
      alignmentScore: score,
      evidenceKeywords: matches,
      status: score >= 30 ? 'aligned' : 'not_addressed',
    });
  }

  return alignment;
}

function checkEthics(content, values) {
  const lower = content.toLowerCase();
  const violations = [];

  for (const guideline of values.ethical_guidelines) {
    const flags = guideline.red_flags.filter((f) => lower.includes(f));
    if (flags.length > 0) {
      violations.push({
        rule: guideline.rule,
        description: guideline.description,
        severity: flags.length >= 2 ? 'high' : 'medium',
        triggers: flags,
      });
    }
  }

  return violations;
}

function generateRecommendations(alignment, violations) {
  const recs = [];
  const unaddressed = alignment.filter((a) => a.status === 'not_addressed');

  if (unaddressed.length > 0) {
    recs.push({
      priority: 'medium',
      action: `Address ${unaddressed.length} unaddressed values: ${unaddressed.map((a) => a.value).join(', ')}`,
    });
  }

  for (const v of violations) {
    recs.push({
      priority: v.severity === 'high' ? 'critical' : 'high',
      action: `Ethical concern: ${v.rule} - review and mitigate: ${v.triggers.join(', ')}`,
    });
  }

  const avgScore = alignment.reduce((s, a) => s + a.alignmentScore, 0) / alignment.length;
  if (avgScore < 30) {
    recs.push({
      priority: 'high',
      action:
        'Overall mission alignment is low. Revisit proposal to explicitly address company values.',
    });
  }

  return recs;
}

runSkill('visionary-ethos-keeper', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const content = fs.readFileSync(resolved, 'utf8');
  const values = loadValues(argv.values);
  const alignment = analyzeAlignment(content, values);
  const violations = checkEthics(content, values);
  const recommendations = generateRecommendations(alignment, violations);

  const avgScore = Math.round(
    alignment.reduce((s, a) => s + a.alignmentScore, 0) / alignment.length
  );
  let grade = 'F';
  if (avgScore >= 80) grade = 'A';
  else if (avgScore >= 60) grade = 'B';
  else if (avgScore >= 40) grade = 'C';
  else if (avgScore >= 20) grade = 'D';

  const result = {
    source: path.basename(resolved),
    mission: values.mission,
    overallScore: avgScore,
    grade,
    ethicalViolations: violations.length,
    alignment,
    violations,
    recommendations,
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
