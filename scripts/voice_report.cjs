#!/usr/bin/env node
const { execSync, spawn } = require('child_process');
const chalk = require('chalk');

/**
 * Voice Report Wrapper
 * Executes a Gemini command and reads the result using macOS 'say'.
 */
async function voiceReport() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(chalk.red('Usage: node scripts/voice_report.cjs "<prompt>"'));
    return;
  }

  const prompt = args[0];
  console.log(chalk.cyan(`\n\ud83e\udde0 Thinking about: "${prompt}"...`));

  try {
    const output = execSync(`gemini --prompt "${prompt.replace(/"/g, '\\"')}"`, { 
      encoding: 'utf8',
      env: { ...process.env, GEMINI_FORMAT: 'text' }
    });

    console.log(chalk.green('\n--- Agent Output ---'));
    console.log(output);

    const speechText = output.substring(0, 500).replace(/[*#`]/g, ''); 

    console.log(chalk.magenta('\n\ud83d\udce2 Reading out results...'));

    // spawn で非同期に実行して終了を待たない
    spawn('say', ['-v', 'Kyoko', '-r', '180', speechText], { detached: true, stdio: 'ignore' });

  } catch (e) {
    console.error(chalk.red(`Error: ${e.message}`));
  }
}

voiceReport();
