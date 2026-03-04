/**
 * scripts/voice_report.ts
 * Executes a Gemini command and reads the result using macOS 'say'.
 */

import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';

async function voiceReport() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(chalk.red('Usage: node voice_report.js "<prompt>"'));
    return;
  }

  const prompt = args[0];
  console.log(chalk.cyan(`\n🧠 Thinking about: "${prompt}"...`));

  try {
    const output = execSync(`gemini --prompt "${prompt.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      env: { ...process.env, GEMINI_FORMAT: 'text' },
    });

    console.log(chalk.green('\n--- Agent Output ---'));
    console.log(output);

    const speechText = output.substring(0, 500).replace(/[*#`]/g, '');

    console.log(chalk.magenta('\n📢 Reading out results...'));

    spawn('say', ['-v', 'Kyoko', '-r', '180', speechText], { detached: true, stdio: 'ignore' });
  } catch (e: any) {
    console.error(chalk.red(`Error: ${e.message}`));
  }
}

voiceReport().catch(err => {
  console.error(err);
  process.exit(1);
});
