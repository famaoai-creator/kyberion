/**
 * libs/core/sensor-engine.ts
 * Kyberion Autonomous Nerve System (KANS) - Sensor Engine v1.0
 * [SECURE-IO COMPLIANT]
 *
 * Provides an abstract foundation for both Reactive (Streaming) and
 * Proactive (Polling) sensory organs.
 */
export type SensorType = 'streaming' | 'polling' | 'event-driven';
export interface SensorConfig {
    id: string;
    name: string;
    type: SensorType;
    interval_ms?: number;
    description?: string;
}
export interface SensorEvent {
    intent: string;
    payload: any;
    priority?: number;
    ttl?: number;
}
/**
 * Base Sensor class providing common GUSP stimulus emission.
 */
export declare abstract class KyberionSensor {
    protected config: SensorConfig;
    protected isRunning: boolean;
    constructor(config: SensorConfig);
    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    /**
     * Standardized stimulus emission into the nerve bus (stimuli.jsonl)
     */
    protected emit(event: SensorEvent): void;
    getStatus(): {
        id: string;
        status: string;
        config: SensorConfig;
    };
}
/**
 * Polling Sensor Specialization
 */
export declare abstract class PollingSensor extends KyberionSensor {
    private timer;
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * The core logic to be implemented by proactive sensors.
     */
    abstract poll(): Promise<void>;
}
//# sourceMappingURL=sensor-engine.d.ts.map