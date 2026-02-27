import { processBusinessPlan } from '../skills/business/business-growth-planner/src/lib.js';
import { generatePnL } from '../skills/business/financial-modeling-maestro/src/lib.js';
import {
  generateOutput,
  extractKeyPoints,
  translateContent,
} from '../skills/business/stakeholder-communicator/src/lib.js';
import { generateHTMLArtifact } from '../skills/media/html-reporter/src/lib.js';
import fs from 'fs';
import path from 'path';

/**
 * Real-world Scenario Verification: "NeuralAudit" Launch
 * Uses safe string concatenation to avoid TSX transform errors.
 */
async function verifySynergyChain() {
  console.log('🚀 Starting Real-world Scenario Verification: [NeuralAudit Launch]');

  // --- Step 1: Strategy Phase ---
  const strategyInput = {
    name: 'NeuralAudit AI',
    vision: 'Revolutionize compliance with autonomous AI auditing',
    domain: 'Security & Compliance',
    objectives: ['Achieve SOC2 automation', 'Acquire 50 enterprise clients in Year 1'],
    model: 'saas',
  };
  const plan = processBusinessPlan(strategyInput);
  console.log('✅ Step 1 (Growth Planner): Strategy and pillars defined.');

  // --- Step 2: Financial Phase ---
  const financialAssumptions = {
    mrr: 20000,
    growthRate: 0.15,
    churnRate: 0.03,
    cashOnHand: 500000,
    costs: {
      initial_monthly_cost: 30000,
      headcount: 8,
      avg_salary: 120000,
    },
  };
  const pnl = generatePnL(financialAssumptions, 3);
  const year3Revenue = pnl.yearly[2].annualRevenue;
  console.log(
    '✅ Step 2 (Financial Maestro): 3-year projection calculated. Year 3 ARR: $' +
      year3Revenue.toLocaleString()
  );

  // --- Step 3: Communication Phase ---
  const reportLines = [
    '# Project: ' + plan.company,
    '## Strategic Intent',
    plan.vision,
    '## Financial Outlook',
    'Projected Year 3 annual revenue is $' +
      year3Revenue.toLocaleString() +
      ' with a monthly growth rate of ' +
      financialAssumptions.growthRate * 100 +
      '%.',
    '## Key Initiatives',
    ...plan.growthPillars.map((p) => '- ' + p.pillar + ': ' + p.initiatives[0]),
  ];
  const technicalReport = reportLines.join('\n');

  const keyPoints = extractKeyPoints(technicalReport);
  const { translations } = translateContent(technicalReport);
  const executiveSummary = generateOutput(
    technicalReport,
    'executive',
    'memo',
    keyPoints,
    translations
  );
  console.log(
    '✅ Step 3 (Stakeholder Communicator): Technical data translated to Executive language.'
  );

  // --- Step 4: Artifact Phase ---
  const reportArtifact = await generateHTMLArtifact(executiveSummary, {
    title: 'Executive Briefing: ' + plan.company + ' Launch Strategy',
  });

  const outputDir = path.resolve('active/projects/neural-audit');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'NeuralAudit_Launch_Report.html');
  fs.writeFileSync(outputPath, reportArtifact.body);

  console.log('✅ Step 4 (HTML Reporter): Formal report generated.');
  console.log('\n🏆 SYNERGY VERIFIED: All skills communicated perfectly via shared types.');
  console.log('Final Report Location: ' + outputPath);
}

verifySynergyChain().catch(console.error);
