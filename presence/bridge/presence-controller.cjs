/**
 * Presence Controller v1.2 (Sovereign Refactor)
 * Orchestrates sensory stimuli across communication channels.
 * Manages the transition from Perception to Action.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../../libs/core/core.cjs');
const { safeReadFile, safeWriteFile, safeExec } = require('../../libs/core/secure-io.cjs');
const pathResolver = require('../../libs/core/path-resolver.cjs');

/**
 * Perception Engine: Gathers pending stimuli, sorted by channel priority.
 */
function perceive() {
  const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/stimuli.jsonl');
  const REGISTRY_PATH = pathResolver.rootResolve('presence/bridge/channel-registry.json');

  if (!fs.existsSync(STIMULI_PATH)) return [];

  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' });
    const stimuli = content.trim().split('\n')
      .map(line => JSON.parse(line))
      .filter(s => s.status === 'PENDING' || s.status === 'INJECTED');

    const registry = JSON.parse(safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }));
    const priorityMap = new Map(registry.channels.map(c => [c.id, c.priority]));

    // Sort by priority desc, then by timestamp asc
    return stimuli.sort((a, b) => {
      const pA = priorityMap.get(a.source_channel) || 0;
      const pB = priorityMap.get(b.source_channel) || 0;
      if (pB !== pA) return pB - pA;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });
  } catch (err) {
    if (logger) logger.error(`Perception Failure: ${err.message}`);
    return [];
  }
}

/**
 * Context Integration: Formats stimuli for the Agent's consciousness.
 */
function getSensoryContext() {
  const REGISTRY_PATH = pathResolver.rootResolve('presence/bridge/channel-registry.json');
  
  const pending = perceive();
  if (pending.length === 0) return null;

  const registry = JSON.parse(safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }));
  
  const formatted = pending.map(s => {
    const channel = registry.channels.find(c => c.id === s.source_channel) || { name: 'Unknown' };
    const priorityMark = channel.priority >= 8 ? ' [URGENT]' : '';
    return `- [Channel: ${channel.name}${priorityMark}] [Mode: ${s.delivery_mode}] Command: ${s.payload}`;
  });

  return `
### 📡 SENSORY INTERVENTION DETECTED:
The following external signals are pending your attention. Please address high-priority (REALTIME) items immediately.

${formatted.join('\n')}

*Instructions: Mark items as processed by referencing their source and intent in your response.*`;
}

/**
 * Marks stimuli as 'PROCESSED' and handles automated replies.
 */
async function resolveStimulus(timestamp, responseText = '') {
  const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/stimuli.jsonl');

  if (!fs.existsSync(STIMULI_PATH)) return;

  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' });
    let stimulusToReply = null;

    const lines = content.trim().split('\n').map(line => {
      const s = JSON.parse(line);
      if (s.timestamp === timestamp) {
        s.status = 'PROCESSED';
        s.resolved_at = new Date().toISOString();
        s.agent_response = responseText;
        stimulusToReply = s;
      }
      return JSON.stringify(s);
    });

    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');

    // Automated Reply Routing
    if (stimulusToReply && responseText) {
      if (stimulusToReply.source_channel === 'slack' && stimulusToReply.metadata) {
        logger.info(`📤 [Presence Bridge] Routing reply to Slack thread: ${stimulusToReply.metadata.thread_ts}`);
        
        const replyPayload = {
          action: 'message',
          channel: stimulusToReply.metadata.channel_id,
          thread_ts: stimulusToReply.metadata.thread_ts,
          input: responseText.replace(/\\n/g, '\n')
        };

        const activeDir = String(pathResolver.active());
        const tempInput = path.join(activeDir, `slack_reply_${Date.now()}.json`);
        
        safeWriteFile(tempInput, JSON.stringify(replyPayload));
        
        try {
          // Use the actual skill to send the message
          safeExec('node', ['scripts/cli.cjs', 'run', 'slack-communicator-pro', '--input', tempInput]);
          logger.success(`✅ [Presence Bridge] Reply sent via slack-communicator-pro.`);
        } catch (err) {
          logger.error(`❌ [Presence Bridge] Failed to send Slack reply: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Resolution Failure: ${err.message}`);
    if (err.stack) logger.error(err.stack);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args[0];

  if (action === 'resolve') {
    const ts = args[1];
    const resp = args[2] || '';
    if (!ts) {
      console.log('Usage: node presence-controller.cjs resolve <timestamp> ["response text"]');
      process.exit(1);
    }
    resolveStimulus(ts, resp).then(() => {
      process.exit(0);
    });
  } else if (action === 'perceive') {
    const pending = perceive();
    console.log(JSON.stringify(pending, null, 2));
  } else {
    console.log('Available actions: perceive, resolve');
  }
}

module.exports = {
  perceive,
  getSensoryContext,
  resolveStimulus
};
