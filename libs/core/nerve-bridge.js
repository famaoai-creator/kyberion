"use strict";
/**
 * libs/core/nerve-bridge.ts
 * Kyberion Autonomous Nerve System (KANS) - Nerve Bridge v1.0
 * [SECURE-IO COMPLIANT]
 *
 * Provides structured messaging (To/From/Type) over the stimuli bus.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNerveMessage = sendNerveMessage;
exports.listenToNerve = listenToNerve;
const fs = __importStar(require("node:fs"));
const index_js_1 = require("./index.js");
const STIMULI_PATH = index_js_1.pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
/**
 * Send a structured message to the nerve bus
 */
function sendNerveMessage(input) {
    const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        ts: new Date().toISOString(),
        from: input.from,
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
    (0, index_js_1.safeAppendFileSync)(STIMULI_PATH, JSON.stringify(msg) + '\n');
    index_js_1.logger.info(`📡 [BRIDGE] Message sent: ${msg.intent} (${msg.from} -> ${msg.to})`);
    return msg.id;
}
/**
 * Polling / Listening logic for a specific nerve
 */
function listenToNerve(nerveId, onMessage) {
    index_js_1.logger.info(`👂 [BRIDGE] Nerve '${nerveId}' started listening to signals...`);
    let lastSize = 0;
    if (fs.existsSync(STIMULI_PATH)) {
        lastSize = fs.statSync(STIMULI_PATH).size;
    }
    setInterval(() => {
        if (!fs.existsSync(STIMULI_PATH))
            return;
        const stats = fs.statSync(STIMULI_PATH);
        if (stats.size > lastSize) {
            const content = fs.readFileSync(STIMULI_PATH, 'utf8');
            const newLines = content.substring(lastSize).trim().split('\n');
            newLines.forEach(line => {
                if (!line)
                    return;
                try {
                    const msg = JSON.parse(line);
                    // Check if message is for us or a broadcast
                    if (msg.to === nerveId || msg.to === 'broadcast') {
                        if (msg.from !== nerveId) { // Don't process our own messages
                            onMessage(msg);
                        }
                    }
                }
                catch (e) {
                    // Partial line or invalid JSON, ignore
                }
            });
            lastSize = stats.size;
        }
    }, 1000);
}
//# sourceMappingURL=nerve-bridge.js.map