import { logger } from '@agent/core/core';
import { metrics } from '@agent/core/metrics';
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

/**
 * The tie-break dialogue is interactive UI, not command output: it goes to
 * stderr (prompt included) so a caller's stdout stays parseable.
 */
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function consultVision(
  context: string,
  options: TieBreakOption[]
): Promise<TieBreakOption> {
  logger.warn(`🚨 [VISION_JUDGE] Logical Deadlock Detected in: ${context}`);

  say(chalk.cyan('\n--- Vision Tie-break Required ---'));
  say(chalk.white(`Context: ${context}`));
  say(
    chalk.gray('The following options are logically similar. Please decide based on your Vision:')
  );

  options.forEach((opt, idx) => {
    say(`${idx + 1}. [${opt.id}] ${opt.description} (Logic: ${opt.logic_score})`);
    if (opt.vision_alignment_hint) {
      say(chalk.italic.yellow(`   💡 AI Thought: ${opt.vision_alignment_hint}`));
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(chalk.bold('\nSelect option (number) or type choice ID: '), (answer) => {
        const choiceIdx = parseInt(answer) - 1;
        const selected = options[choiceIdx] || options.find((o) => o.id === answer);

        if (selected) {
          rl.close();
          metrics.recordIntervention(context, selected.id);
          logger.success(`✅ Vision set to: ${selected.id}`);
          resolve(selected);
        } else {
          say(chalk.red('Invalid selection. Try again.'));
          ask();
        }
      });
    };
    ask();
  });
}
