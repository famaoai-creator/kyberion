#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const _fs = require('fs');
const _path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const argv = createStandardYargs()
  .option('count', {
    alias: 'n',
    type: 'number',
    default: 3,
    description: 'Number of personas to generate',
  })
  .option('product', {
    alias: 'p',
    type: 'string',
    default: 'SaaS application',
    description: 'Product description',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const PERSONA_TEMPLATES = [
  {
    archetype: 'Beginner',
    techLevel: 'low',
    patience: 'low',
    goals: ['Get started quickly', 'Understand basics'],
    frustrations: ['Complex setup', 'Jargon-heavy docs'],
    accessibility: null,
  },
  {
    archetype: 'Power User',
    techLevel: 'high',
    patience: 'high',
    goals: ['Maximize productivity', 'Customize workflows'],
    frustrations: ['Feature limitations', 'No API access'],
    accessibility: null,
  },
  {
    archetype: 'Mobile-First User',
    techLevel: 'medium',
    patience: 'low',
    goals: ['Use on phone', 'Quick actions'],
    frustrations: ['Desktop-only features', 'Slow mobile load'],
    accessibility: null,
  },
  {
    archetype: 'Accessibility User',
    techLevel: 'medium',
    patience: 'medium',
    goals: ['Navigate with screen reader', 'Keyboard-only operation'],
    frustrations: ['Missing alt text', 'Focus traps', 'Low contrast'],
    accessibility: { screenReader: true, keyboardOnly: true, colorBlind: false },
  },
  {
    archetype: 'Enterprise Admin',
    techLevel: 'high',
    patience: 'medium',
    goals: ['Manage team access', 'Audit compliance', 'SSO integration'],
    frustrations: ['No bulk operations', 'Missing audit logs'],
    accessibility: null,
  },
  {
    archetype: 'Non-English Speaker',
    techLevel: 'medium',
    patience: 'medium',
    goals: ['Use in native language', 'Understand UI without translation'],
    frustrations: ['English-only UI', 'Untranslated error messages'],
    accessibility: null,
  },
  {
    archetype: 'Elderly User',
    techLevel: 'low',
    patience: 'high',
    goals: ['Read text clearly', 'Simple navigation'],
    frustrations: ['Small text', 'Complex menus', 'Hover-only interactions'],
    accessibility: { largeText: true, simpleNavigation: true },
  },
  {
    archetype: 'API Developer',
    techLevel: 'high',
    patience: 'low',
    goals: ['Integrate via API', 'Read API docs', 'Test endpoints'],
    frustrations: ['Outdated docs', 'No sandbox environment'],
    accessibility: null,
  },
];

function generatePersonas(count, product) {
  const selected = PERSONA_TEMPLATES.slice(0, Math.min(count, PERSONA_TEMPLATES.length));
  return selected.map((template, i) => ({
    id: `persona-${i + 1}`,
    name: `${template.archetype} User`,
    archetype: template.archetype,
    profile: { techLevel: template.techLevel, patience: template.patience, product },
    goals: template.goals,
    frustrations: template.frustrations,
    accessibility: template.accessibility,
    testScenarios: generateScenarios(template, product),
  }));
}

function generateScenarios(persona, product) {
  const scenarios = [];
  scenarios.push({
    scenario: `First-time ${product} setup as ${persona.archetype}`,
    priority: 'high',
    expectedDuration: persona.patience === 'low' ? '< 5 min' : '< 15 min',
  });
  if (persona.accessibility) {
    if (persona.accessibility.screenReader)
      scenarios.push({
        scenario: 'Navigate main workflow with screen reader',
        priority: 'critical',
        expectedDuration: '< 10 min',
      });
    if (persona.accessibility.keyboardOnly)
      scenarios.push({
        scenario: 'Complete purchase flow using only keyboard',
        priority: 'critical',
        expectedDuration: '< 10 min',
      });
  }
  scenarios.push({
    scenario: `Handle error state as ${persona.archetype}`,
    priority: 'medium',
    expectedDuration: '< 3 min',
  });
  return scenarios;
}

runSkill('synthetic-user-persona', () => {
  const personas = generatePersonas(argv.count, argv.product);
  const accessibilityPersonas = personas.filter((p) => p.accessibility);
  const result = {
    product: argv.product,
    personaCount: personas.length,
    personas,
    accessibilityCoverage: {
      personasWithA11y: accessibilityPersonas.length,
      totalScenarios: personas.reduce((s, p) => s + p.testScenarios.length, 0),
    },
    recommendations: [
      `${personas.length} personas generated for ${argv.product}`,
      accessibilityPersonas.length > 0
        ? `${accessibilityPersonas.length} accessibility persona(s) - prioritize their test scenarios`
        : 'Consider adding accessibility personas for inclusive testing',
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
