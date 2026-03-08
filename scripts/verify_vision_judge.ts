import { logger } from '@agent/core';
import * as visionJudge from '@agent/shared-vision';

/**
 * scripts/verify_vision_judge.ts
 * Demonstrates the Vision Tie-break mechanism.
 */

async function main() {
  logger.info('Starting Decision Simulation: Client vs Server Architecture');

  const context = 'Choosing the primary architecture for the next-gen fintech app.';
  
  const options: visionJudge.TieBreakOption[] = [
    {
      id: 'CLIENT_THICK',
      description: 'Heavy Client (React/Native) with offline capabilities and smooth UI.',
      logic_score: 0.85,
      vision_alignment_hint: 'Fits "UX is King" vision.'
    },
    {
      id: 'SERVER_THICK',
      description: 'Heavy Server (SSR/Remix) with centralized logic and high security.',
      logic_score: 0.84,
      vision_alignment_hint: 'Fits "Security and Compliance first" vision.'
    }
  ];

  logger.info('AI Analysis: Logic scores are within 1% margin. Triggering Vision Judge.');

  const decision = await visionJudge.consultVision(context, options);

  logger.success(`Executing Strategy based on your Vision: ${decision.id}`);
  console.log(`Action: Scaling ${decision.id === 'CLIENT_THICK' ? 'Frontend' : 'Backend'} resources...`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
