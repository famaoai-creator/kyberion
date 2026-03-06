import { logger } from './core.js';
import { metrics } from './metrics.js';
import * as readline from 'node:readline';
import chalk from 'chalk';

/**
 * Vision Judge Utility
 * Helps AI break logical deadlocks by consulting the Sovereign (Vision).
 */

export interface TieBreakOption {
  id: string;
  description: string;
  logic_score: number; // e.g., 0.0 to 1.0
  vision_alignment_hint?: string; // AI's guess on how it fits the Vision
}

export async function consultVision(
  context: string,
  options: TieBreakOption[]
): Promise<TieBreakOption> {
  logger.warn(`🚨 [VISION_JUDGE] Logical Deadlock Detected in: ${context}`);
  
  console.log(chalk.cyan('\n--- Vision Tie-break Required ---'));
  console.log(chalk.white(`Context: ${context}`));
  console.log(chalk.gray('The following options are logically similar. Please decide based on your Vision:'));

  options.forEach((opt, idx) => {
    console.log(`${idx + 1}. [${opt.id}] ${opt.description} (Logic: ${opt.logic_score})`);
    if (opt.vision_alignment_hint) {
      console.log(chalk.italic.yellow(`   💡 AI Thought: ${opt.vision_alignment_hint}`));
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(chalk.bold('\nSelect option (number) or type choice ID: '), (answer) => {
        const choiceIdx = parseInt(answer) - 1;
        const selected = options[choiceIdx] || options.find(o => o.id === answer);

        if (selected) {
          rl.close();
          metrics.recordIntervention(context, selected.id);
          logger.success(`✅ Vision set to: ${selected.id}`);
          resolve(selected);
        }
 else {
          console.log(chalk.red('Invalid selection. Try again.'));
          ask();
        }
      });
    };
    ask();
  });
}
