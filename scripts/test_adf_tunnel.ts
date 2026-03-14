import { handleAction } from '../libs/actuators/terminal-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testADFTunnel() {
  logger.info('🚀 Testing ADF Tunnel Concept...');

  // 1. Spawn a shell
  const { sessionId } = await handleAction({
    action: 'spawn',
    params: { shell: '/bin/sh' }
  });
  logger.info(`✅ Session created: ${sessionId}`);

  // 2. Shout an ADF command from within the shell
  // This simulates a CLI tool or script requesting an external action (e.g. browser screenshot)
  const adfCommand = JSON.stringify({
    actuator: 'browser-actuator',
    action: 'screenshot',
    params: { url: 'https://example.com' }
  });

  logger.info(`Writing command: echo '>>ADF${adfCommand}<<'`);
  await handleAction({
    action: 'write',
    params: { 
      sessionId, 
      data: `echo '>>ADF${adfCommand}<<'\r` 
    }
  });

  // 3. Wait and check logs (the detection happens in ptyEngine callback)
  await new Promise(r => setTimeout(r, 1000));

  // 4. Cleanup
  await handleAction({ action: 'kill', params: { sessionId } });
  logger.info('✅ ADF Tunnel test complete. Check console logs for [ADF_TUNNEL] markers.');
}

testADFTunnel().catch(console.error);
