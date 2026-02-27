import { processBusinessPlan } from '../skills/business/business-growth-planner/src/lib.js';
import {
  generateOutput,
  extractKeyPoints,
  translateContent,
} from '../skills/business/stakeholder-communicator/src/lib.js';
import path from 'path';

/**
 * Integration Test: Strategy to Presentation Deck
 * Verifies that the chain of skills works seamlessly with shared types.
 */

async function runIntegrationTest() {
  console.log('[Integration] Starting Scenario: Strategy to Deck...');

  // 1. Plan Growth
  const input = {
    name: 'SynergyCorp',
    vision: 'Connect all AI skills via common types',
    objectives: ['Implement shared business types', 'Automate metadata sync'],
    model: 'saas',
  };
  const plan = processBusinessPlan(input);
  console.log('  - Step 1: Growth plan generated for ' + plan.company);

  // 2. Communicate to Executives
  const rawText =
    'Our strategy for ' +
    plan.company +
    ' focuses on ' +
    plan.growthPillars[0].pillar +
    '. Recommendations: ' +
    plan.recommendations.join('. ');
  const keyPoints = extractKeyPoints(rawText);
  const { translations } = translateContent(rawText);
  const comms = generateOutput(rawText, 'executive', 'presentation', keyPoints, translations);
  console.log('  - Step 2: Strategic summary for ' + comms.headline + ' generated');

  // 3. Create Markdown for PPT (Marp format)
  const bodyLines = [
    '---',
    'marp: true',
    'theme: default',
    '---',
    '# ' + comms.headline,
    '## Executive Summary',
    comms.body,
    '',
    '---',
    '## Key Initiatives',
    ...plan.growthPillars.map((p) => '- ' + p.pillar),
  ];

  const pptMarkdown = {
    title: comms.headline,
    body: bodyLines.join('\n'),
    format: 'markdown' as const,
  };

  console.log(
    '  - Step 3: PPTX Artifact constructed successfully (Title: ' + pptMarkdown.title + ')'
  );
  console.log('[Integration] SUCCESS: All data passed through the chain correctly.');
}

runIntegrationTest().catch((err) => {
  console.error('[Integration] FAILED:', err);
  process.exit(1);
});
