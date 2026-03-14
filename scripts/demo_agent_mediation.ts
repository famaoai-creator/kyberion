import { AgentMediator, logger } from '../libs/core/index.js';
import * as path from 'node:path';

async function runMediationDemo() {
  logger.info('🚀 Starting Agent Intermediation Demo...');

  const mediator = new AgentMediator({
    threadId: 'mediation-test-001',
    promptPattern: 'AI-GUEST > ',
    bootCommand: '/bin/sh',
    bootArgs: [path.resolve(process.cwd(), 'scripts/mock_agent_cli.sh')],
    timeoutMs: 10000
  });

  // 1. Boot the agent
  const bootOutput = await mediator.boot();
  logger.info(`[DEMO] Agent Boot Output:\n${bootOutput}`);

  // 2. Ask a question
  const response1 = await mediator.ask('What is Kyberion?');
  logger.info(`[DEMO] Agent Response 1:\n${response1}`);

  // 3. Ask another question
  const response2 = await mediator.ask('Analyze the system.');
  logger.info(`[DEMO] Agent Response 2:\n${response2}`);

  // 4. Shutdown
  await mediator.shutdown();
  logger.info('🏁 Mediation Demo complete.');
}

runMediationDemo().catch(console.error);
