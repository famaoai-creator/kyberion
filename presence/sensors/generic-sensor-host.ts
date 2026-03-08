/**
 * presence/sensors/generic-sensor-host.ts
 * Kyberion Generic Sensor Host v1.2
 * [SECURE-IO COMPLIANT]
 */

import { KyberionSensor, PollingSensor, logger, safeReadFile, safeExec, pathResolver, safeReaddir, safeStat, safeExistsSync } from '../../libs/core/index.js';
import { handleAction as dispatchService } from '../../libs/actuators/service-actuator/src/index.js';
import * as path from 'node:path';

interface SensorADF {
  id: string;
  name: string;
  type: 'polling' | 'streaming' | 'event-driven';
  assigned_role?: string;
  interval_ms?: number;
  source?: {
    path: string;
    recursive?: boolean;
    pattern?: string;
  };
  connection?: {
    service_id: string;
    auth?: 'secret-guard' | 'none';
  };
  action: {
    actuator: string;
    command: string;
    args?: string[];
    params?: any;
  };
  on_change?: {
    intent: string;
    priority?: number;
  };
}

/**
 * Polling Implementation
 */
class GenericPollingSensor extends PollingSensor {
  private adf: SensorADF;
  private lastHash: string = '';

  constructor(adf: SensorADF) {
    super({
      id: adf.id,
      name: adf.name,
      type: adf.type,
      interval_ms: adf.interval_ms
    });
    this.adf = adf;
  }

  async poll() {
    logger.info(`🔍 [${this.config.id}] Polling via ${this.adf.action.actuator}...`);
    try {
      const output = await safeExec(this.adf.action.command, this.adf.action.args || []);
      if (output !== this.lastHash && output.trim().length > 0) {
        if (this.lastHash !== '') {
          this.emit({
            intent: this.adf.on_change?.intent || 'CHANGE_DETECTED',
            payload: { raw: output.substring(0, 1000) }
          });
        }
        this.lastHash = output;
      }
    } catch (err: any) {
      logger.error(`❌ [${this.config.id}] Poll failed: ${err.message}`);
    }
  }
}

/**
 * Streaming Implementation
 */
class GenericStreamingSensor extends KyberionSensor {
  private adf: SensorADF;

  constructor(adf: SensorADF) {
    super({
      id: adf.id,
      name: adf.name,
      type: adf.type
    });
    this.adf = adf;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`👂 [${this.config.id}] Starting stream via ${this.adf.connection?.service_id}...`);

    try {
      if (this.adf.connection?.service_id === 'slack') {
        await dispatchService({
          service_id: 'slack',
          mode: 'STREAM',
          action: 'start',
          params: {},
          auth: this.adf.connection.auth || 'secret-guard'
        }, (data) => {
          logger.info(`📥 [${this.config.id}] Signal detected: ${data.type}`);
          this.emit({
            intent: 'COMMAND',
            payload: { source: 'slack', text: data.event.text, user: data.event.user },
            priority: 5
          });
        });
      }
    } catch (err: any) {
      logger.error(`❌ [${this.config.id}] Stream failed: ${err.message}`);
      this.isRunning = false;
    }
  }

  async stop() {
    this.isRunning = false;
    logger.info(`🛑 [${this.config.id}] Stream stopped.`);
  }
}

/**
 * Watch (Event-driven) Implementation
 */
class GenericWatchSensor extends KyberionSensor {
  private adf: SensorADF;
  private offsets = new Map<string, number>();

  constructor(adf: SensorADF) {
    super({
      id: adf.id,
      name: adf.name,
      type: adf.type
    });
    this.adf = adf;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`👁️ [${this.config.id}] Watching path: ${this.adf.source?.path}`);

    setInterval(async () => {
      if (!this.isRunning) return;
      await this.scan();
    }, this.adf.interval_ms || 10000);
    
    await this.scan();
  }

  async scan() {
    if (!this.adf.source) return;
    const resolvedPath = path.resolve(process.cwd(), this.adf.source.path);
    
    if (!safeExistsSync(resolvedPath)) return;

    try {
      const files = safeReaddir(resolvedPath).filter(f => {
        if (!this.adf.source?.pattern) return true;
        const regex = new RegExp(this.adf.source.pattern.replace(/\*/g, '.*'));
        return regex.test(f);
      });

      for (const file of files) {
        const filePath = path.join(this.adf.source.path, file);
        const lastPos = this.offsets.get(file) || 0;
        
        const stats = safeStat(filePath);
        if (stats.size > lastPos) {
          const content = (safeReadFile(filePath, { encoding: 'utf8' }) as string).substring(lastPos);
          if (content.trim()) {
            this.handleNewContent(file, content);
          }
          this.offsets.set(file, stats.size);
        }
      }
    } catch (err: any) {
      logger.error(`❌ [${this.config.id}] Scan failed: ${err.message}`);
    }
  }

  private handleNewContent(file: string, content: string) {
    const lines = content.split('\n');
    const keywords = this.adf.action.params?.keywords || [];
    
    for (const line of lines) {
      const match = keywords.length === 0 || keywords.some((k: string) => line.toUpperCase().includes(k.toUpperCase()));
      if (match && line.trim()) {
        this.emit({
          intent: this.adf.on_change?.intent || 'LOG_ALERT',
          payload: { file, line: line.trim() },
          priority: this.adf.on_change?.priority || 5
        });
      }
    }
  }

  async stop() {
    this.isRunning = false;
    logger.info(`🛑 [${this.config.id}] Watcher stopped.`);
  }
}

async function main() {
  const adfPath = process.argv[2];
  if (!adfPath) throw new Error('Usage: generic-sensor-host.ts <adf-path>');

  const content = safeReadFile(path.resolve(process.cwd(), adfPath), { encoding: 'utf8' }) as string;
  const adf = JSON.parse(content) as SensorADF;

  if (adf.assigned_role) {
    process.env.MISSION_ROLE = adf.assigned_role;
    logger.info(`🛡️ [SensorHost] Context established as: ${adf.assigned_role}`);
  }

  let sensor: KyberionSensor;
  if (adf.type === 'streaming') {
    sensor = new GenericStreamingSensor(adf);
  } else if (adf.type === 'event-driven') {
    sensor = new GenericWatchSensor(adf);
  } else {
    sensor = new GenericPollingSensor(adf);
  }
    
  await sensor.start();
}

main().catch(err => {
  console.error(`CRITICAL: Sensor Host failed: ${err.message}`);
  process.exit(1);
});
