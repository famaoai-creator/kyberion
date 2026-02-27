const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as path from 'node:path';
import * as fs from 'node:fs';

export function createShadowTasks(
  intent: string,
  personaA: string,
  personaB: string,
  inboxDir: string
): { idA: string; idB: string } {
  const timestamp = Date.now();
  const idA = 'SHADOW-A-' + timestamp;
  const idB = 'SHADOW-B-' + timestamp;
  const taskA = { id: idA, intent: '[Role: ' + personaA + '] ' + intent, status: 'pending' };
  const taskB = { id: idB, intent: '[Role: ' + personaB + '] ' + intent, status: 'pending' };

  if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });

  safeWriteFile(path.join(inboxDir, idA + '.json'), JSON.stringify(taskA));
  safeWriteFile(path.join(inboxDir, idB + '.json'), JSON.stringify(taskB));
  return { idA, idB };
}
