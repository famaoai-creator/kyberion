import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { 
  logger, 
  pathResolver, 
  safeWriteFile, 
  safeMkdir,
  safeExistsSync,
  withLock
} from '../libs/core/index.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
};

async function runOnboarding() {
  const ROOT_DIR = pathResolver.rootDir();
  const personalDir = path.join(ROOT_DIR, 'knowledge/personal');
  const identityPath = path.join(personalDir, 'my-identity.json');

  console.log('\n🌟 Welcome to Kyberion Ecosystem Onboarding 🌟\n');
  console.log('I will help you establish your Sovereign Identity to unlock full capabilities.\n');

  if (safeExistsSync(identityPath)) {
    const overwrite = await ask('An identity already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Onboarding cancelled. Existing identity preserved.');
      process.exit(0);
    }
  }

  const name = await ask('1. What is your name or how should I call you? (e.g., Sovereign, Master, Commander): ') || 'Sovereign';
  const language = await ask('2. Preferred language? (e.g., Japanese, English) [Japanese]: ') || 'Japanese';
  
  console.log('\n3. Choose your preferred interaction style:');
  console.log('   - [S]enior Partner: Professional & strategic dialogue.');
  console.log('   - [C]oncierge: Polite, proactive, and guiding (default).');
  console.log('   - [M]inimalist: Concise and efficiency-focused.');
  const styleCode = (await ask('Choice (S/C/M) [C]: ')).toUpperCase() || 'C';
  
  const styleMap: Record<string, string> = {
    'S': 'Senior Partner',
    'C': 'Concierge',
    'M': 'Minimalist'
  };
  const style = styleMap[styleCode] || 'Concierge';

  const domain = await ask('4. Primary domain? (e.g., Software Engineering, Data Analysis, Writing) [General]: ') || 'General';

  const identity = {
    name,
    language,
    interaction_style: style,
    primary_domain: domain,
    created_at: new Date().toISOString(),
    status: 'active',
    version: '1.0.0'
  };

  // Ensure directories exist
  const tiers = ['knowledge/personal', 'knowledge/confidential', 'knowledge/public'];
  for (const tier of tiers) {
    const tierPath = path.join(ROOT_DIR, tier);
    if (!safeExistsSync(tierPath)) {
      console.log(`Creating directory: ${tier}`);
      safeMkdir(tierPath, { recursive: true });
    }
  }

  // Write identity file
  await withLock('sovereign-identity', async () => {
    safeWriteFile(identityPath, JSON.stringify(identity, null, 2));
  });

  console.log('\n✅ Sovereign Identity established successfully!');
  console.log(`Saved to: ${identityPath}\n`);

  // --- NEW: Agent Greeting & Naming ---
  console.log('--------------------------------------------------');
  console.log('🤖 Agent Greeting & Naming Ceremony');
  console.log('--------------------------------------------------');
  console.log('\nNice to meet you, ' + name + '. I am your autonomous partner.');
  console.log('To collaborate with other agents (A2A) and record immutable evidence,');
  console.log('I also require a formal Agent ID.\n');

  const proposedAgentId = 'KYBERION-PRIME';
  console.log(`I propose the Agent ID: [${chalk.bold.cyan(proposedAgentId)}]`);
  const agentNameChoice = await ask(`Accept this name or provide a new one? (Enter to accept / [Name]): `);
  const finalAgentId = (agentNameChoice || proposedAgentId).toUpperCase();

  const agentIdentity = {
    agent_id: finalAgentId,
    version: '1.0.0',
    role: 'Ecosystem Architect / Senior Partner',
    owner: name,
    trust_tier: 'sovereign',
    created_at: new Date().toISOString(),
    description: `The primary autonomous entity of the Kyberion Ecosystem for ${name}.`
  };

  const agentIdentityPath = path.join(personalDir, 'agent-identity.json');
  await withLock('agent-identity', async () => {
    safeWriteFile(agentIdentityPath, JSON.stringify(agentIdentity, null, 2));
  });

  console.log(`\n✨ Agent Identity established: ${chalk.bold.green(finalAgentId)}`);
  console.log(`Saved to: ${agentIdentityPath}\n`);
  // ------------------------------------

  console.log('Next steps:');
  console.log('1. Run missions with: pnpm mission:create');
  console.log('2. Check health with: pnpm vital');
  console.log('\nWelcome aboard, ' + name + '.\n');

  rl.close();
}

runOnboarding().catch(err => {
  console.error('Onboarding failed:', err);
  process.exit(1);
});
