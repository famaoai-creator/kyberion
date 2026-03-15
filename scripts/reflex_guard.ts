/**
 * scripts/reflex_guard.ts
 * Kyberion Autonomous Nerve System (KANS) - Reflex Guard v1.0 [ZERO-DEP]
 * 
 * Objective: 
 * Watch stimuli.jsonl for terminal outputs and inject EXECUTION_FINISHED 
 * when a prompt is detected, enabling automated agent response.
 */

const {
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeReadFile,
  safeStat,
  safeWriteFile,
} = require('../libs/core/index.js');

// Constants
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PROMPT_PATTERN = /[%$#]>?\s*$/m;

console.log('🛡️ [ReflexGuard] Initializing... Watching for neural signals in stimuli.jsonl');

/**
 * Clean ANSI escape sequences from terminal output
 */
function cleanOutput(text) {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
}

/**
 * Inject a new stimulus into the log
 */
function injectStimulus(intent, payload, originalId) {
  const stimulus = {
    id: `reflex-${Date.now()}`,
    ts: new Date().toISOString(),
    ttl: 30,
    origin: { channel: 'reflex-guard', source_id: originalId },
    signal: { intent: intent, priority: 5, payload: payload },
    control: { status: 'processed', feedback: 'silent', evidence: [] }
  };
  safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
  console.log(`⚡ [ReflexGuard] Injected reflex stimulus: ${intent}`);
}

// Ensure the file exists
if (!safeExistsSync(STIMULI_PATH)) {
  safeWriteFile(STIMULI_PATH, '');
}

// Watch the file for changes
let lastSize = safeStat(STIMULI_PATH).size;

setInterval(() => {
  const stats = safeStat(STIMULI_PATH);
  if (stats.size > lastSize) {
    const fullContent = safeReadFile(STIMULI_PATH, { encoding: 'utf8' });
    const data = String(fullContent).slice(lastSize);
    const lines = data.trim().split('\n');
    lines.forEach(line => {
      if (!line) return;
      try {
        const stimulus = JSON.parse(line);
        // Only react to terminal log streams from agents
        if (stimulus.origin?.channel === 'terminal' && stimulus.signal?.intent !== 'EXECUTION_FINISHED') {
          const cleanText = cleanOutput(stimulus.signal.payload || '');
          if (PROMPT_PATTERN.test(cleanText)) {
            injectStimulus('EXECUTION_FINISHED', 'System is ready for next instruction.', stimulus.id);
          }
        }
      } catch (e) {
        // Ignore parse errors for partial lines
      }
    });
    lastSize = stats.size;
  } else if (stats.size < lastSize) {
    // Handle file rotation/truncation
    lastSize = stats.size;
  }
}, 1000);
