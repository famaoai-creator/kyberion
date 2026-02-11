#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to JSON with business goals and context' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function generateOKRs(goals) {
  return (goals.objectives || []).map((obj, i) => ({
    objective: obj,
    keyResults: [
      `KR${i + 1}.1: Define measurable target for "${obj}"`,
      `KR${i + 1}.2: Achieve 70% progress in Q1`,
      `KR${i + 1}.3: Complete full rollout by Q2`,
    ],
  }));
}

function analyzeMarketEntry(_input) {
  const strategies = [];
  const market = _input.target_market || {};
  if (market.size === 'large' || market.tam > 1000000000) strategies.push({ strategy: 'Land & Expand', description: 'Start with SMB segment, expand to enterprise', risk: 'medium' });
  else strategies.push({ strategy: 'Niche Focus', description: 'Dominate a specific vertical before expanding', risk: 'low' });
  if (_input.competitive_landscape === 'fragmented') strategies.push({ strategy: 'Consolidation Play', description: 'Acquire smaller competitors to gain market share', risk: 'high' });
  if (_input.product_readiness === 'mvp') strategies.push({ strategy: 'Product-Led Growth', description: 'Offer freemium tier to drive adoption', risk: 'low' });
  return strategies;
}

function defineRevenueStreams(input) {
  const streams = [];
  if (input.model === 'saas' || !input.model) {
    streams.push({ stream: 'SaaS Subscriptions', description: 'Recurring monthly/annual subscriptions', potential: 'high' });
    streams.push({ stream: 'Enterprise Licensing', description: 'Custom pricing for large accounts', potential: 'high' });
  }
  if (input.has_api || input.model === 'platform') streams.push({ stream: 'API Usage Fees', description: 'Pay-per-use API access', potential: 'medium' });
  if (input.has_data) streams.push({ stream: 'Data Insights', description: 'Anonymized analytics and benchmarking', potential: 'medium' });
  streams.push({ stream: 'Professional Services', description: 'Implementation, training, and consulting', potential: 'medium' });
  return streams;
}

function createGrowthPillars(_input) {
  return [
    { pillar: 'Product Excellence', initiatives: ['Feature parity with top competitor', 'UX/accessibility improvements', 'Performance optimization'] },
    { pillar: 'Market Expansion', initiatives: ['Enter new geographic market', 'Launch partner program', 'Industry-specific solutions'] },
    { pillar: 'Operational Efficiency', initiatives: ['Automate customer onboarding', 'Reduce support ticket volume by 30%', 'Implement self-service portal'] },
    { pillar: 'Team & Culture', initiatives: ['Hire key roles per roadmap', 'Knowledge sharing program', 'Quarterly innovation sprints'] },
  ];
}

runSkill('business-growth-planner', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const input = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const okrs = generateOKRs(input);
  const marketStrategies = analyzeMarketEntry(input);
  const revenueStreams = defineRevenueStreams(input);
  const pillars = createGrowthPillars(input);
  const result = {
    company: input.company || 'Unknown', vision: input.vision || '',
    okrs, marketEntryStrategies: marketStrategies, revenueStreams, growthPillars: pillars,
    recommendations: [
      okrs.length === 0 ? 'Define clear objectives in your input' : `${okrs.length} OKRs generated`,
      `${marketStrategies.length} market entry strategies identified`,
      `${revenueStreams.length} revenue streams mapped`,
    ],
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
