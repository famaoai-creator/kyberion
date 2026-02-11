#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to requirements or system description' })
  .option('standard', { alias: 's', type: 'string', default: 'ipa', choices: ['ipa', 'iso25010', 'general'], description: 'Quality standard to use' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const VIEWPOINTS = {
  ipa: {
    name: 'IPA Non-functional Grade (2018)',
    viewpoints: [
      { id: 'performance', name: 'Performance', subItems: ['Response time', 'Throughput', 'Resource usage'], weight: 20 },
      { id: 'reliability', name: 'Reliability', subItems: ['Fault tolerance', 'Recoverability', 'Availability (SLA)'], weight: 20 },
      { id: 'usability', name: 'Usability', subItems: ['Learnability', 'Operability', 'Error prevention'], weight: 15 },
      { id: 'security', name: 'Security', subItems: ['Authentication', 'Authorization', 'Data protection', 'Audit trail'], weight: 20 },
      { id: 'maintainability', name: 'Maintainability', subItems: ['Modularity', 'Testability', 'Analyzability'], weight: 15 },
      { id: 'portability', name: 'Portability', subItems: ['Adaptability', 'Installability', 'Replaceability'], weight: 10 },
    ],
  },
  iso25010: {
    name: 'ISO 25010',
    viewpoints: [
      { id: 'functional-suitability', name: 'Functional Suitability', subItems: ['Completeness', 'Correctness', 'Appropriateness'], weight: 15 },
      { id: 'performance-efficiency', name: 'Performance Efficiency', subItems: ['Time behavior', 'Resource utilization', 'Capacity'], weight: 15 },
      { id: 'compatibility', name: 'Compatibility', subItems: ['Co-existence', 'Interoperability'], weight: 10 },
      { id: 'usability', name: 'Usability', subItems: ['Recognizability', 'Learnability', 'Operability', 'Accessibility'], weight: 15 },
      { id: 'reliability', name: 'Reliability', subItems: ['Maturity', 'Availability', 'Fault tolerance', 'Recoverability'], weight: 15 },
      { id: 'security', name: 'Security', subItems: ['Confidentiality', 'Integrity', 'Non-repudiation', 'Accountability', 'Authenticity'], weight: 15 },
      { id: 'maintainability', name: 'Maintainability', subItems: ['Modularity', 'Reusability', 'Analysability', 'Modifiability', 'Testability'], weight: 10 },
      { id: 'portability', name: 'Portability', subItems: ['Adaptability', 'Installability', 'Replaceability'], weight: 5 },
    ],
  },
  general: {
    name: 'General Quality',
    viewpoints: [
      { id: 'performance', name: 'Performance', subItems: ['Speed', 'Scalability'], weight: 25 },
      { id: 'security', name: 'Security', subItems: ['Auth', 'Data safety'], weight: 25 },
      { id: 'reliability', name: 'Reliability', subItems: ['Uptime', 'Error handling'], weight: 25 },
      { id: 'usability', name: 'Usability', subItems: ['UX', 'Accessibility'], weight: 25 },
    ],
  },
};

function analyzeRequirements(content, standard) {
  const lower = content.toLowerCase();
  const viewpoints = VIEWPOINTS[standard].viewpoints;
  const coverage = viewpoints.map(vp => {
    const mentioned = vp.subItems.filter(si => lower.includes(si.toLowerCase().split(' ')[0]));
    const score = vp.subItems.length > 0 ? Math.round((mentioned.length / vp.subItems.length) * 100) : 0;
    return { ...vp, coverage: score, mentionedItems: mentioned, missingItems: vp.subItems.filter(si => !mentioned.includes(si)) };
  });
  return coverage;
}

function generateTestScenarios(coverage) {
  const scenarios = [];
  for (const vp of coverage) {
    for (const item of vp.missingItems) {
      scenarios.push({ viewpoint: vp.name, item, priority: vp.weight >= 20 ? 'critical' : vp.weight >= 15 ? 'high' : 'medium', scenario: `Verify ${item.toLowerCase()} meets requirements under ${vp.name}`, type: 'non-functional' });
    }
  }
  return scenarios.sort((a, b) => { const p = { critical: 0, high: 1, medium: 2 }; return (p[a.priority] || 3) - (p[b.priority] || 3); });
}

runSkill('test-viewpoint-analyst', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const content = fs.readFileSync(resolved, 'utf8');
  const standard = VIEWPOINTS[argv.standard];
  const coverage = analyzeRequirements(content, argv.standard);
  const scenarios = generateTestScenarios(coverage);
  const overallCoverage = Math.round(coverage.reduce((s, c) => s + c.coverage * c.weight, 0) / coverage.reduce((s, c) => s + c.weight, 0));
  const result = {
    source: path.basename(resolved), standard: standard.name,
    overallCoverage, viewpointCoverage: coverage,
    testScenarios: scenarios.slice(0, 30), scenarioCount: scenarios.length,
    recommendations: coverage.filter(c => c.coverage < 50).map(c => `[${c.weight >= 20 ? 'critical' : 'high'}] ${c.name}: only ${c.coverage}% covered - add test viewpoints for ${c.missingItems.join(', ')}`),
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
