/**
 * libs/core/sensor-engine.ts
 * Kyberion Autonomous Nerve System (KANS) - Sensor Engine v1.0
 * [SECURE-IO COMPLIANT]
 * 
 * Provides an abstract foundation for both Reactive (Streaming) and 
 * Proactive (Polling) sensory organs.
 */

import { logger, safeAppendFileSync, pathResolver } from './index.js';

export type SensorType = 'streaming' | 'polling' | 'event-driven';

export interface SensorConfig {
  id: string;
  name: string;
  type: SensorType;
  interval_ms?: number; // For polling sensors
  description?: string;
}

export interface SensorEvent {
  intent: string;
  payload: any;
  priority?: number;
  ttl?: number;
}

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

/**
 * Base Sensor class providing common GUSP stimulus emission.
 */
export abstract class KyberionSensor {
  protected config: SensorConfig;
  protected isRunning: boolean = false;

  constructor(config: SensorConfig) {
    this.config = config;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /**
   * Standardized stimulus emission into the nerve bus (stimuli.jsonl)
   */
  protected emit(event: SensorEvent) {
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
      safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
      logger.info(`📡 [SENSOR:${this.config.id}] Emitted: ${event.intent}`);
    } catch (err) {
      logger.error(`❌ [SENSOR:${this.config.id}] Failed to emit stimulus: ${err}`);
    }
  }

  public getStatus() {
    return {
      id: this.config.id,
      status: this.isRunning ? 'ACTIVE' : 'INACTIVE',
      config: this.config
    };
  }
}

/**
 * Polling Sensor Specialization
 */
export abstract class PollingSensor extends KyberionSensor {
  private timer: NodeJS.Timeout | null = null;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`🚀 [SENSOR:${this.config.id}] Polling started every ${this.config.interval_ms}ms`);
    
    this.timer = setInterval(async () => {
      try {
        await this.poll();
      } catch (err) {
        logger.error(`⚠️ [SENSOR:${this.config.id}] Poll cycle failed: ${err}`);
      }
    }, this.config.interval_ms || 60000);
    
    // Initial poll
    await this.poll();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.isRunning = false;
    logger.info(`🛑 [SENSOR:${this.config.id}] Polling stopped.`);
  }

  /**
   * The core logic to be implemented by proactive sensors.
   */
  abstract poll(): Promise<void>;
}
