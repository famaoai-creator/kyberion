import { ACPMediator, logger, presenceAction } from '../libs/core/index.js';

async function testA2UIFeedbackLoop() {
  logger.info('🚀 Testing A2UI Feedback Loop (CopilotKit Style)...');

  const threadId = 'a2ui-loop-thread';
  const mediator = new ACPMediator({
    threadId,
    bootCommand: 'gemini',
    bootArgs: ['--acp', '--approval-mode=yolo']
  });

  try {
    await mediator.boot();
    logger.info('✅ Agent session ready.');

    // 1. Initial Prompt
    logger.info('Sending initial prompt...');
    const prompt = `DO NOT use any tools. DO NOT write any files. Just reply with exactly this text:
>>A2UI{"createSurface":{"surfaceId":"test-ui","catalogId":"kyberion.org:standard","title":"Test UI"}}<<`;
    const result = await mediator.ask(prompt);
    logger.info(`Agent Output: ${result}`);

    // 2. Simulate User Interaction on the UI
    logger.info('--- SIMULATING UI INTERACTION ---');
    logger.info('User clicks a button on "test-ui"...');
    
    await presenceAction({
      action: 'receive_event',
      params: {
        channel: 'web-dashboard',
        payload: {
          threadId,
          targetPersona: 'KYBERION-PRIME',
          event_type: 'button_click',
          event_data: { button_id: 'deploy-btn', action: 'deploy_now' }
        }
      }
    });

    // 3. Ask the Mediator to check for messages
    // In a real app, the mediator would poll messages before each turn
    logger.info('Waiting for mediator to pick up the UI event...');
    
    // We send a tiny empty prompt or follow-up to trigger the next turn
    // and see if the persona can see the message in the bus.
    const followUp = await mediator.ask('Check your message bus. Did you see the UI event?');
    logger.info(`Agent Follow-up Result: ${followUp}`);

  } catch (err: any) {
    logger.error(`❌ Feedback loop failed: ${err.message}`);
  } finally {
    await mediator.shutdown();
    logger.info('🏁 Feedback loop test complete.');
  }
}

testA2UIFeedbackLoop().catch(console.error);
