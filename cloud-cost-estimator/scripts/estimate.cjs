#!/usr/bin/env node
/**
 * cloud-cost-estimator/scripts/estimate.cjs
 * Pure Engine: Data-Driven FinOps Auditor
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('@agent/core/secure-io');
const { requireArgs } = require('@agent/core/validators');

runSkill('cloud-cost-estimator', () => {
  const argv = requireArgs(['input', 'out']);
  const inputPath = path.resolve(argv.input);
  const outputPath = path.resolve(argv.out);

  // 1. Load Knowledge (Pricing & Rules)
  const rulesPath = path.resolve(
    __dirname,
    '../../knowledge/skills/cloud-cost-estimator/cost-rules.json'
  );
  const { instance_pricing, optimization_rules } = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

  // 2. Load Source of Truth (Infrastructure ADF)
  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const findings = [];
  let totalMonthlyCost = 0;

  // 3. Analyze logic
  adf.nodes.forEach((node) => {
    const pricing = instance_pricing[node.type];
    if (pricing) {
      const unitCost = pricing[node.details?.size || 't3.micro'] || 0.01;
      const monthlyCost = unitCost * 24 * 30;
      totalMonthlyCost += monthlyCost;

      // Apply Optimization Rules
      optimization_rules.forEach((rule) => {
        if (node.type === rule.target) {
          findings.push({
            resource: node.id,
            action: rule.action,
            potential_savings: rule.savings ? monthlyCost * rule.savings : 0,
          });
        }
      });
    }
  });

  const report = {
    title: 'Cloud FinOps Audit',
    summary: {
      total_monthly_estimated: totalMonthlyCost,
      currency: 'USD',
    },
    optimizations: findings,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, JSON.stringify(report, null, 2));

  return {
    status: 'success',
    total_cost: totalMonthlyCost,
    finding_count: findings.length,
    output: outputPath,
  };
});
