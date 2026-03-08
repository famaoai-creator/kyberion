/**
 * Daemon-Actuator v1.2.0
 * Kyberion Nerve Service Manager (KNSM)
 * [SECURE-IO COMPLIANT]
 * 
 * Objectives:
 * 1. Persistent background execution via OS-native daemons (launchd).
 * 2. Auto-recovery of neural processes (KeepAlive).
 * 3. Support for ADF-driven Sensors via generic-sensor-host.
 */

import { 
  logger, 
  safeReadFile, 
  safeWriteFile, 
  pathResolver, 
  safeExec,
  safeExistsSync,
  safeStat,
  safeUnlinkSync
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { sendNerveMessage, NerveMessage } from '../../../core/nerve-bridge.js';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT_DIR = pathResolver.rootDir();
const TEMPLATE_PATH = path.join(ROOT_DIR, 'libs/actuators/daemon-actuator/templates/launchd.plist.xml.template');
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');

interface DaemonAction {
  action: 'register' | 'start' | 'stop' | 'status' | 'unregister' | 'run-once' | 'post-msg' | 'wait-msg';
  nerve_id: string; 
  script_path?: string; 
  adf_path?: string; // Path to a Sensor ADF
  options?: {
    ephemeral?: boolean; 
    env?: Record<string, string>;
    intent?: string;
    payload?: any;
    target?: string;
  };
}

async function handleAction(input: DaemonAction) {
  const label = `kyberion.${input.nerve_id}`;
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);

  // Auto-resolve for ADF-driven sensors
  let finalScriptPath = input.script_path;
  let finalArgs: string[] = [];

  if (input.adf_path) {
    finalScriptPath = 'dist/presence/sensors/generic-sensor-host.js';
    finalArgs = [path.join(ROOT_DIR, input.adf_path)];
    logger.info(`🗺️ [DAEMON] ADF detected. Using generic sensor host for: ${input.adf_path}`);
  }

  switch (input.action) {
    case 'post-msg':
      const msgId = sendNerveMessage({
        to: input.options?.target || 'broadcast',
        from: input.nerve_id,
        intent: input.options?.intent || 'COMMAND',
        payload: input.options?.payload || {},
        type: 'request'
      });
      return { status: 'sent', message_id: msgId };

    case 'wait-msg':
      logger.info(`⏳ [DAEMON] Waiting for response on nerve: ${input.nerve_id}...`);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ status: 'timeout' }), 30000);
        const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
        let lastSize = safeExistsSync(STIMULI_PATH) ? safeStat(STIMULI_PATH).size : 0;

        const interval = setInterval(() => {
          if (!safeExistsSync(STIMULI_PATH)) return;
          const stats = safeStat(STIMULI_PATH);
          if (stats.size > lastSize) {
            const content = (safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string).substring(lastSize);
            const lines = content.trim().split('\n');
            for (const line of lines) {
              try {
                const msg = JSON.parse(line) as NerveMessage;
                if (msg.to === input.nerve_id && msg.type === 'response') {
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve({ status: 'received', payload: msg.payload });
                }
              } catch (e) {}
            }
            lastSize = stats.size;
          }
        }, 1000);
      });

    case 'register':
    case 'run-once':
      if (!finalScriptPath) throw new Error('script_path or adf_path is required.');
      logger.info(`🛰️ [DAEMON] Registering nerve: ${input.nerve_id} (Ephemeral: ${!!input.options?.ephemeral})`);
      
      let template = safeReadFile(TEMPLATE_PATH, { encoding: 'utf8' }) as string;
      const keepAlive = input.options?.ephemeral ? 'false' : 'true';
      
      const fullScriptPath = path.isAbsolute(finalScriptPath) ? finalScriptPath : path.join(ROOT_DIR, finalScriptPath);
      const programArgs = [process.execPath, fullScriptPath, ...finalArgs];
      let programArgsXml = '';
      programArgs.forEach(arg => {
        programArgsXml += `\n        <string>${arg}</string>`;
      });

      const replacements: Record<string, string> = {
        '{{NERVE_ID}}': input.nerve_id,
        '{{LOG_PATH}}': path.join(ROOT_DIR, `active/shared/logs/${input.nerve_id}.log`),
        '{{ERROR_LOG_PATH}}': path.join(ROOT_DIR, `active/shared/logs/${input.nerve_id}.error.log`),
        '{{ROOT_DIR}}': ROOT_DIR,
        '{{ENV_PATH}}': process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        '<key>KeepAlive</key>\n    <true/>': `<key>KeepAlive</key>\n    <${keepAlive}/>`,
        '<key>ProgramArguments</key>\n    <array>\n        <string>{{NODE_PATH}}</string>\n        <string>{{SCRIPT_PATH}}</string>\n    </array>': `<key>ProgramArguments</key>\n    <array>${programArgsXml}\n    </array>`
      };

      Object.entries(replacements).forEach(([key, val]) => {
        template = template.split(key).join(val);
      });

      safeWriteFile(plistPath, template, { __sudo: 'sovereign' } as any);
      logger.info(`✅ [DAEMON] Plist created: ${plistPath}`);
      
      if (input.action === 'run-once') {
        logger.info(`🚀 [DAEMON] Auto-starting nerve: ${label}`);
        await safeExec('launchctl', ['load', '-w', plistPath]);
      }
      return { status: 'registered', plist: plistPath };

    case 'stop':
      logger.info(`🛑 [DAEMON] Stopping nerve: ${label}`);
      await safeExec('launchctl', ['unload', '-w', plistPath]);
      
      const content = safeReadFile(plistPath, { encoding: 'utf8' }) as string;
      if (content.includes('<key>KeepAlive</key>\n    <false/>')) {
        logger.info(`🧹 [DAEMON] Cleaning up ephemeral plist: ${plistPath}`);
        safeUnlinkSync(plistPath);
      }
      return { status: 'stopped' };

    case 'status':
      try {
        const output = await safeExec('launchctl', ['list', label]);
        return { status: 'alive', raw: output };
      } catch (err) {
        return { status: 'dead', error: 'Service not found.' };
      }

    case 'unregister':
      if (safeExistsSync(plistPath)) {
        await safeExec('launchctl', ['unload', '-w', plistPath]);
        safeUnlinkSync(plistPath);
      }
      return { status: 'unregistered' };

    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}

// CLI Integration
const isMain = process.argv[1] && (
  process.argv[1].endsWith('daemon-actuator/src/index.ts') || 
  process.argv[1].endsWith('daemon-actuator/dist/index.js')
);

if (isMain) {
  const argv = createStandardYargs()
    .option('action', { type: 'string', demandOption: true })
    .option('nerve', { type: 'string', demandOption: true })
    .option('script', { type: 'string' })
    .option('adf', { type: 'string' })
    .option('options', { type: 'string' })
    .parseSync();

  let options = {};
  if (argv.options) {
    try { options = JSON.parse(argv.options as string); } catch (e) {}
  }

  handleAction({
    action: argv.action as any,
    nerve_id: argv.nerve as string,
    script_path: argv.script as string,
    adf_path: argv.adf as string,
    options
  })
    .then(res => console.log(JSON.stringify(res, null, 2)))
    .catch(err => {
      logger.error(`❌ [DAEMON] Action failed: ${err.message}`);
      process.exit(1);
    });
}

export { handleAction };
