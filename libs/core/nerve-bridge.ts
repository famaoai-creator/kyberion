/**
 * libs/core/nerve-bridge.ts
 * Kyberion Autonomous Nerve System (KANS) - Nerve Bridge v1.2
 * [SECURE-IO COMPLIANT]
 * 
 * Provides structured messaging (To/From/Type) over the stimuli bus
 * with Distributed Node Identification (Nerve Cluster Foundation).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { logger, pathResolver, safeWriteFile, safeReadFile, safeAppendFileSync } from './index.js';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const NODE_ID = `${os.hostname()}-${process.pid}`;

export interface NerveMessage {
  id: string;
  ts: string;
  from: string;
  node_id: string; // Distributed Node Identity
  to: string | 'broadcast';
  type: 'request' | 'response' | 'event';
  intent: string;
  payload: any;
  metadata?: {
    reply_to?: string;
    mission_id?: string;
    ttl?: number;
  };
}

/**
 * Send a structured message to the nerve bus
 */
export function sendNerveMessage(input: {
  to: string | 'broadcast',
  from: string,
  intent: string,
  payload: any,
  type?: NerveMessage['type'],
  replyTo?: string
}): string {
  const msg: NerveMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    ts: new Date().toISOString(),
    from: input.from,
    node_id: NODE_ID,
    to: input.to,
    type: input.type || 'event',
    intent: input.intent,
    payload: input.payload,
    metadata: {
      reply_to: input.replyTo,
      mission_id: process.env.MISSION_ID,
      ttl: 60
    }
  };

  try {
    safeAppendFileSync(STIMULI_PATH, JSON.stringify(msg) + '\n');
    logger.info(`📡 [BRIDGE:${NODE_ID}] Message sent: ${msg.intent} (${msg.from} -> ${msg.to})`);
  } catch (_) {}
  
  return msg.id;
}

/**
 * Polling / Listening logic for a specific nerve
 */
export function listenToNerve(nerveId: string, onMessage: (msg: NerveMessage) => void) {
  logger.info(`👂 [BRIDGE:${NODE_ID}] Nerve '${nerveId}' started listening...`);
  
  let lastSize = 0;
  if (fs.existsSync(STIMULI_PATH)) {
    lastSize = fs.statSync(STIMULI_PATH).size;
  }

  setInterval(() => {
    if (!fs.existsSync(STIMULI_PATH)) return;
    
    const stats = fs.statSync(STIMULI_PATH);
    if (stats.size > lastSize) {
      const content = fs.readFileSync(STIMULI_PATH, 'utf8');
      const newLines = content.substring(lastSize).trim().split('\n');
      
      newLines.forEach(line => {
        if (!line) return;
        try {
          const msg = JSON.parse(line) as NerveMessage;
          // Accept if broadcast or targeted to us, and not from the same node process
          if ((msg.to === nerveId || msg.to === 'broadcast') && msg.node_id !== NODE_ID) {
            onMessage(msg);
          }
        } catch (e) {}
      });
      lastSize = stats.size;
    }
  }, 1000);
}
