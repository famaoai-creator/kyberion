import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import chalk from 'chalk';

const ROOT_DIR = process.cwd();
const MAPPING_PATH = path.join(ROOT_DIR, 'knowledge/orchestration/meta-skills/intent_mapping.yaml');
const SKILL_INDEX_PATH = path.join(ROOT_DIR, 'knowledge/orchestration/global_skill_index.json');

interface IntentMapping {
  intents: Array<{
    name: string;
    trigger_phrases: string[];
    chain: string[];
  }>;
}

export async function runGateway(query: string) {
  console.log(chalk.cyan(`🔍 Gateway: Analyzing intent for query: "${query}"...`));

  const mapping = yaml.load(fs.readFileSync(MAPPING_PATH, 'utf8')) as IntentMapping;
  const index = JSON.parse(fs.readFileSync(SKILL_INDEX_PATH, 'utf8'));
  const skills = index.s || index.skills || [];

  // Simple keyword matching for prototype
  const detected = mapping.intents.find(intent => 
    intent.trigger_phrases.some(phrase => query.toLowerCase().includes(phrase.toLowerCase()))
  );

  if (!detected) {
    console.log(chalk.yellow('⚠️  Gateway: No specific intent chain matched. Falling back to Generalist.'));
    return;
  }

  console.log(chalk.green(`✅ Gateway: Intent "${detected.name}" matched.`));
  console.log(chalk.white('\n--- DYNAMICALLY LOADED SKILLS ---'));

  for (const skillName of detected.chain) {
    const skillInfo = skills.find((s: any) => s.n === skillName || s.name === skillName);
    if (skillInfo) {
      const skillMdPath = path.join(ROOT_DIR, skillInfo.path, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        const content = fs.readFileSync(skillMdPath, 'utf8').split('\n').slice(0, 10).join('\n');
        console.log(chalk.blue(`\n[LOADED] ${skillName}`));
        console.log(chalk.gray(content + '\n... (Manual loaded into context)'));
      }
    }
  }

  console.log(chalk.cyan('\n🚀 Ready to execute the chain. Execute the first skill to begin.'));
}

// CLI Execution
const query = process.argv.slice(2).join(' ');
if (query) {
  runGateway(query);
}
