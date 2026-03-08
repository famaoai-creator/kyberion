"use strict";
/**
 * libs/core/sensor-engine.ts
 * Kyberion Autonomous Nerve System (KANS) - Sensor Engine v1.0
 * [SECURE-IO COMPLIANT]
 *
 * Provides an abstract foundation for both Reactive (Streaming) and
 * Proactive (Polling) sensory organs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PollingSensor = exports.KyberionSensor = void 0;
const index_js_1 = require("./index.js");
const STIMULI_PATH = index_js_1.pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
/**
 * Base Sensor class providing common GUSP stimulus emission.
 */
class KyberionSensor {
    config;
    isRunning = false;
    constructor(config) {
        this.config = config;
    }
    /**
     * Standardized stimulus emission into the nerve bus (stimuli.jsonl)
     */
    emit(event) {
        const timestamp = new Date();
        const stimulus = {
            id: `sns-${this.config.id}-${timestamp.getTime()}`,
            ts: timestamp.toISOString(),
            ttl: event.ttl || 3600,
            origin: {
                channel: 'sensor',
                source_id: this.config.id
            },
            signal: {
                intent: event.intent,
                priority: event.priority || 5,
                payload: event.payload
            },
            control: {
                status: 'pending',
                feedback: 'auto',
                evidence: []
            }
        };
        try {
            (0, index_js_1.safeAppendFileSync)(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
            index_js_1.logger.info(`📡 [SENSOR:${this.config.id}] Emitted: ${event.intent}`);
        }
        catch (err) {
            index_js_1.logger.error(`❌ [SENSOR:${this.config.id}] Failed to emit stimulus: ${err}`);
        }
    }
    getStatus() {
        return {
            id: this.config.id,
            status: this.isRunning ? 'ACTIVE' : 'INACTIVE',
            config: this.config
        };
    }
}
exports.KyberionSensor = KyberionSensor;
/**
 * Polling Sensor Specialization
 */
class PollingSensor extends KyberionSensor {
    timer = null;
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        index_js_1.logger.info(`🚀 [SENSOR:${this.config.id}] Polling started every ${this.config.interval_ms}ms`);
        this.timer = setInterval(async () => {
            try {
                await this.poll();
            }
            catch (err) {
                index_js_1.logger.error(`⚠️ [SENSOR:${this.config.id}] Poll cycle failed: ${err}`);
            }
        }, this.config.interval_ms || 60000);
        // Initial poll
        await this.poll();
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.isRunning = false;
        index_js_1.logger.info(`🛑 [SENSOR:${this.config.id}] Polling stopped.`);
    }
}
exports.PollingSensor = PollingSensor;
