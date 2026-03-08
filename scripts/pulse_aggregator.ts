/**
 * scripts/pulse_aggregator.ts
 * Kyberion Autonomous Nerve System (KANS) - Pulse Aggregator v1.1 [DAEMON READY]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = process.cwd();
const PULSE_PATH = path.join(ROOT_DIR, 'active/shared/runtime/pulse.json');
const STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');

interface NerveStatus {
  id: string;
  name: string;
  status: 'ALIVE' | 'DEAD' | 'ERROR';
  last_pulse?: string;
  last_event?: string;
  pid?: number;
}

const NERVES: NerveStatus[] = [
  { id: 'nexus', name: 'Nexus Daemon', status: 'DEAD' },
  { id: 'terminal', name: 'Terminal Server', status: 'DEAD' },
  { id: 'task-watcher', name: 'Task Watcher', status: 'DEAD' },
  { id: 'log-watcher-adf', name: 'Log Watcher', status: 'DEAD' },
  { id: 'visual-buffer', name: 'Visual Buffer', status: 'DEAD' }
];

async function refreshPids(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ps = spawn('ps', ['-ef']);
    let output = '';
    ps.stdout.on('data', (data) => output += data);
    ps.on('close', () => {
      NERVES.forEach(nerve => {
        const match = output.split('\n').find(line => line.includes(nerve.id));
        if (match) {
          const pidMatch = match.trim().split(/\s+/)[1];
          nerve.status = 'ALIVE';
          nerve.pid = parseInt(pidMatch);
          nerve.last_pulse = new Date().toISOString();
        } else {
          nerve.status = 'DEAD';
          nerve.pid = undefined;
        }
      });
      resolve();
    });
  });
}

function persistPulse() {
  const pulseData = {
    ts: new Date().toISOString(),
    system: 'Kyberion Autonomous Nerve System [DAEMON]',
    nerves: NERVES
  };
  fs.writeFileSync(PULSE_PATH, JSON.stringify(pulseData, null, 2));
}

setInterval(async () => {
  await refreshPids();
  persistPulse();
}, 5000);

console.log('🛰️ [KANS] Pulse Aggregator (Daemon Mode) started.');
