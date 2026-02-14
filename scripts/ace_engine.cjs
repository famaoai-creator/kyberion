#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { ui, logger, fileUtils } = require('./lib/core.cjs');
const aceCore = require('./lib/ace-core.cjs');
const personaLoader = require('./lib/persona-loader.cjs');

const rootDir = path.resolve(__dirname, '..');
const minutesPath = path.join(rootDir, 'work/committee/minutes.md');
const matrixPath = path.join(rootDir, 'knowledge/personalities/matrix.md');

async function runCommittee(topic, evidencePath) {
  console.log(chalk.bold.bgBlue(`\n ACE (Autonomous Consensus Engine) v2.0 - Knowledge Driven `));
  console.log(chalk.cyan(`Topic: ${topic}`));

  // 1. Load Knowledge (Personas)
  const personas = personaLoader.loadPersonas(matrixPath);
  logger.info(`Loaded ${Object.keys(personas).length} personas from knowledge base.`);

  // 2. Load Evidence
  let evidence = "No evidence provided.";
  if (evidencePath && fs.existsSync(evidencePath)) {
    evidence = fs.readFileSync(evidencePath, 'utf8').substring(0, 2000); // Truncate for prompt
    logger.info(`Loaded evidence from ${path.basename(evidencePath)}`);
  }

  const votes = [];
  const committeeMembers = [
    'The Ecosystem Architect',
    'The ECC Security Reviewer',
    'The Pragmatic CTO'
  ];

  for (const member of committeeMembers) {
    const p = personas[member];
    if (!p) continue;

    console.log(chalk.yellow(`\n--- [${member}] is analyzing ---`));
    console.log(chalk.dim(`Viewpoint: ${p.viewpoint}`));

    // In a real scenario, this would be an AI call. 
    // Here we simulate the AI's response being shaped by the Persona's Knowledge.
    const thought = `[Simulated AI Response based on Knowledge]
Role: ${p.role}
Tone: ${p.tone}
Analysis: Given the evidence, I focus on "${p.viewpoint}". 
The current situation shows some drift from our standards. I recommend a cautious approach.`;

    const score = member.includes('Security') ? 'S2' : 'U2';
    votes.push({ role: member, securityScore: score, urgencyScore: 'U2', comment: "Knowledge-based evaluation required." });
    
    aceCore.appendThought(minutesPath, member, thought);
  }

  // 4. Final Evaluation
  const result = aceCore.evaluateDecision(votes);
  
  console.log(chalk.bold(`\n--- Final Committee Result ---`));
  const theme = result.decision === 'GO' ? chalk.bgGreen.black : (result.decision === 'YELLOW-CARD' ? chalk.bgYellow.black : chalk.bgRed.white);
  console.log(theme(` DECISION: ${result.decision} `));
  console.log(chalk.dim(`Reason: ${result.reason}`));

  aceCore.appendThought(minutesPath, 'Moderator (Karo)', `委員会の結論: ${result.decision}. ナレッジ駆動による判定完了。`);
}

async function main() {
  const args = process.argv.slice(2);
  const topic = args[0] || 'multi-agent-shogun の移植判定';
  const evidence = args[1] || 'PERFORMANCE_DASHBOARD.md';

  try {
    await runCommittee(topic, path.resolve(rootDir, evidence));
  } catch (err) {
    logger.error(err.message);
  }
}

main();
