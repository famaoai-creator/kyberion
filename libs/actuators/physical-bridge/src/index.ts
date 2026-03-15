import { logger, safeReadFile, safeWriteFile, pathResolver, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * Physical-Bridge Actuator v1.0 [KUCA COMPLIANT]
 * Orchestrates physical devices (Browser, OS, Camera, Voice) using KUCA ADF.
 */

interface KUCAAction {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  key?: string;
  duration_ms?: number;
  target?: string;
}

interface KUCAInput {
  actions: KUCAAction[];
  auto_observe?: boolean;
  session_id?: string;
}

async function executeAction(action: KUCAAction, sessionId = 'default') {
  const tempActionPath = path.join(process.cwd(), `active/shared/logs/action_${Date.now()}.json`);
  
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'scroll':
    case 'browser_type':
      // Route to Browser-Actuator
      logger.info(`🌐 [BRIDGE] Routing to Browser: ${action.type}`);
      safeWriteFile(tempActionPath, JSON.stringify({ action: action.type, session_id: sessionId, ...action }));
      return await safeExec('node', ['dist/scripts/cli.js', 'run', 'browser-actuator', '--input', tempActionPath]);

    case 'system_mouse_click':
    case 'system_keypress':
      // Route to System-Actuator
      logger.info(`⌨️  [BRIDGE] Routing to System: ${action.type}`);
      const systemAction = {
        action: action.type.includes('mouse') ? 'mouse' : 'keyboard',
        x: action.x,
        y: action.y,
        button: action.button,
        text: action.text,
        key: action.key
      };
      safeWriteFile(tempActionPath, JSON.stringify(systemAction));
      return await safeExec('node', ['dist/scripts/cli.js', 'run', 'system-actuator', '--input', tempActionPath]);

    case 'voice_output':
      logger.info(`🗣️ [BRIDGE] Routing to Voice: ${action.text}`);
      safeWriteFile(tempActionPath, JSON.stringify({ action: 'voice', text: action.text }));
      return await safeExec('node', ['dist/scripts/cli.js', 'run', 'system-actuator', '--input', tempActionPath]);

    case 'camera_capture':
      logger.info(`📸 [BRIDGE] Routing to Camera`);
      // Future implementation for macOS camera satellite
      return { status: 'captured', path: 'evidence/camera/latest.jpg' };

    case 'wait':
      logger.info(`⏳ [BRIDGE] Waiting for ${action.duration_ms}ms...`);
      await new Promise(r => setTimeout(r, action.duration_ms || 1000));
      return { status: 'waited' };

    default:
      logger.warn(`⚠️ [BRIDGE] Unsupported action type: ${action.type}`);
      return { status: 'skipped', type: action.type };
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const input = JSON.parse(inputContent) as KUCAInput;
  const sessionId = input.session_id || 'default';

  const results = [];
  for (const action of input.actions) {
    const result = await executeAction(action, sessionId);
    results.push({ action: action.type, result });
  }

  // Auto-Observation Loop
  let observation: any = null;
  if (input.auto_observe) {
    logger.info(`📸 [BRIDGE] Auto-observing result for session: ${sessionId}`);
    const obsPath = path.join(process.cwd(), `active/shared/logs/obs_${Date.now()}.json`);
    safeWriteFile(obsPath, JSON.stringify({ action: 'snapshot', session_id: sessionId }));
    
    try {
      const obsResult = await safeExec('node', ['dist/scripts/cli.js', 'run', 'browser-actuator', '--input', obsPath]);
      observation = JSON.parse(obsResult);
    } catch (err: any) {
      logger.error(`❌ [BRIDGE] Auto-observation failed: ${err.message}`);
    }
  }

  console.log(JSON.stringify({ status: 'success', results, observation }, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(`Physical Bridge Error: ${err.message}`);
    process.exit(1);
  });
}
