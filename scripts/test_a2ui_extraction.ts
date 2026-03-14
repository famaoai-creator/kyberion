import { ACPMediator, logger } from '../libs/core/index.js';

async function testA2UIExtraction() {
  logger.info('🚀 Testing A2UI Smart Rendering via Gemini...');

  const mediator = new ACPMediator({
    threadId: 'a2ui-extract-thread',
    bootCommand: 'gemini',
    bootArgs: ['--acp'],
    modelId: 'gemini-2.5-flash' // Use Flash for speed
  });

  try {
    await mediator.boot();
    logger.info('✅ Mediator ready.');

    const prompt = `Please create a simple A2UI dashboard for a weather monitoring system. 
Use the following format in your response:
>>A2UI{"createSurface":{"surfaceId":"weather-dash","catalogId":"kyberion.org:weather","title":"Weather Dashboard"}}<<
Followed by:
>>A2UI{"updateComponents":{"surfaceId":"weather-dash","components":[{"id":"root","type":"layout:column","props":{"padding":"10px"},"children":["temp-gauge"]},{"id":"temp-gauge","type":"display:gauge","props":{"label":"Temperature","value":24,"unit":"C"}}]}}<<
Just output these tags.`;

    logger.info('Requesting A2UI Generation...');
    const result = await mediator.ask(prompt);
    logger.info(`[GEMINI_RAW_RESULT]:\n${result}`);

  } catch (err: any) {
    logger.error(`❌ A2UI Extraction test failed: ${err.message}`);
  } finally {
    await mediator.shutdown();
    logger.info('🏁 A2UI Extraction test complete.');
  }
}

testA2UIExtraction().catch(console.error);
