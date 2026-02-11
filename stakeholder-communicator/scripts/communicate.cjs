#!/usr/bin/env node
/**
 * stakeholder-communicator: Translates technical content into business-oriented
 * language for non-technical stakeholders.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to technical document or JSON report',
  })
  .option('audience', {
    alias: 'a',
    type: 'string',
    default: 'executive',
    choices: ['executive', 'board', 'marketing', 'sales', 'all-hands'],
    description: 'Target audience',
  })
  .option('format', {
    alias: 'f',
    type: 'string',
    default: 'summary',
    choices: ['summary', 'email', 'presentation', 'memo'],
    description: 'Output format',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

const AUDIENCE_PROFILES = {
  executive: { label: 'Executive Team', focus: ['ROI', 'risk', 'timeline', 'strategic impact'], avoid: ['implementation details', 'code specifics', 'technical jargon'] },
  board: { label: 'Board of Directors', focus: ['financial impact', 'market position', 'risk mitigation', 'growth trajectory'], avoid: ['technical details', 'operational minutiae'] },
  marketing: { label: 'Marketing Team', focus: ['user benefits', 'competitive advantage', 'messaging opportunities', 'timeline for announcements'], avoid: ['backend architecture', 'database changes'] },
  sales: { label: 'Sales Team', focus: ['customer value', 'feature differentiation', 'talking points', 'competitive positioning'], avoid: ['internal refactoring', 'tech debt'] },
  'all-hands': { label: 'All Hands', focus: ['team achievement', 'product improvement', 'upcoming plans', 'how it helps users'], avoid: ['sensitive financial data', 'individual performance'] },
};

const TECH_TO_BIZ = [
  { tech: /refactor/gi, biz: 'system modernization' },
  { tech: /technical debt/gi, biz: 'maintenance backlog' },
  { tech: /CI\/CD|pipeline/gi, biz: 'automated delivery process' },
  { tech: /API/gi, biz: 'integration capability' },
  { tech: /microservice/gi, biz: 'modular architecture' },
  { tech: /database migration/gi, biz: 'data infrastructure upgrade' },
  { tech: /unit test|test coverage/gi, biz: 'quality assurance' },
  { tech: /deployment/gi, biz: 'release' },
  { tech: /latency|response time/gi, biz: 'speed and responsiveness' },
  { tech: /scalab/gi, biz: 'growth capacity' },
  { tech: /security patch|vulnerability/gi, biz: 'security enhancement' },
  { tech: /containeriz/gi, biz: 'cloud-ready packaging' },
  { tech: /dependency/gi, biz: 'component' },
  { tech: /codebase/gi, biz: 'product foundation' },
  { tech: /bug fix/gi, biz: 'issue resolution' },
  { tech: /performance optimization/gi, biz: 'speed improvement' },
];

function translateContent(content) {
  let translated = content;
  const translations = [];
  for (const rule of TECH_TO_BIZ) {
    const matches = content.match(rule.tech);
    if (matches) {
      translated = translated.replace(rule.tech, rule.biz);
      translations.push({ from: matches[0], to: rule.biz });
    }
  }
  return { translated, translations };
}

function extractKeyPoints(content) {
  const points = [];
  const _lines = content.split('\n').filter(l => l.trim().length > 10);

  // Look for metrics/numbers
  const metrics = content.match(/\d+\.?\d*\s*(%|percent|users|customers|hours|days|ms|seconds)/gi);
  if (metrics) points.push(...metrics.slice(0, 5).map(m => ({ type: 'metric', value: m.trim() })));

  // Look for impact statements
  const impactPatterns = /(?:improve|reduce|increase|decrease|save|eliminate|enable|prevent)[\w\s]{5,60}/gi;
  const impacts = content.match(impactPatterns);
  if (impacts) points.push(...impacts.slice(0, 3).map(i => ({ type: 'impact', value: i.trim() })));

  return points;
}

function generateOutput(content, audience, format, keyPoints, translations) {
  const profile = AUDIENCE_PROFILES[audience];
  const { translated } = translateContent(content);

  const sections = {
    headline: `Update for ${profile.label}`,
    summary: translated.substring(0, 500),
    keyPoints: keyPoints.map(p => p.value),
    focusAreas: profile.focus,
    translationsApplied: translations.length,
  };

  if (format === 'email') {
    sections.structure = {
      subject: `[Update] ${sections.headline}`,
      opening: `Here is a brief update on recent progress relevant to the ${profile.label}.`,
      body: sections.summary,
      closing: 'Please reach out if you have any questions or need further details.',
    };
  } else if (format === 'presentation') {
    sections.structure = {
      slide1: { title: sections.headline, bullets: keyPoints.slice(0, 3).map(p => p.value) },
      slide2: { title: 'Impact & Benefits', bullets: profile.focus },
      slide3: { title: 'Next Steps', bullets: ['Review timeline', 'Align resources', 'Schedule follow-up'] },
    };
  } else if (format === 'memo') {
    sections.structure = {
      to: profile.label,
      from: 'Engineering',
      subject: sections.headline,
      body: sections.summary,
      action_required: 'Review and provide feedback by next meeting.',
    };
  }

  return sections;
}

runSkill('stakeholder-communicator', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const raw = fs.readFileSync(resolved, 'utf8');
  let content = raw;

  // If JSON, extract readable content
  try {
    const json = JSON.parse(raw);
    content = JSON.stringify(json, null, 2);
    if (json.data) content = JSON.stringify(json.data, null, 2);
  } catch (_e) { /* plain text */ }

  const { translations } = translateContent(content);
  const keyPoints = extractKeyPoints(content);
  const output = generateOutput(content, argv.audience, argv.format, keyPoints, translations);

  const result = {
    source: path.basename(resolved),
    audience: argv.audience,
    format: argv.format,
    audienceProfile: AUDIENCE_PROFILES[argv.audience],
    translationsApplied: translations,
    keyPoints,
    output,
  };

  if (argv.out) {
    if (argv.out.endsWith('.md')) {
      const md = [`# ${output.headline}`, '', output.summary, '', '## Key Points', ...keyPoints.map(p => `- ${p.value}`), ''].join('\n');
      fs.writeFileSync(argv.out, md);
    } else {
      fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
    }
  }

  return result;
});
