import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { 
  logger, 
  pathResolver, 
  safeWriteFile, 
  safeMkdir,
  safeExistsSync
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
  safeWriteFile(identityPath, JSON.stringify(identity, null, 2));

  console.log('\n✅ Sovereign Identity established successfully!');
  console.log(`Saved to: ${identityPath}\n`);
  
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
