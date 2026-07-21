import { buildSafeExecEnv } from './secure-io.js';
import {
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from './managed-process.js';
import { rootResolve } from './path-resolver.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import {
  createCoreAudioDeviceInventoryBridge,
  type CoreAudioDeviceInventoryBridge,
} from './coreaudio-device-inventory.js';
import {
  pcmSignalMetrics,
  type AudioDeviceDescriptor,
  type AudioOutputPort,
  type AudioRouteHealth,
  type AudioRouteMetrics,
  type AudioRouteProbe,
} from './audio-route.js';

export interface CoreAudioOutputBridgeOptions {
  inventory_bridge?: CoreAudioDeviceInventoryBridge;
  swift_bin?: string;
  script_path?: string;
  startup_timeout_ms?: number;
  cleanup_timeout_ms?: number;
}

export class CoreAudioOutputBridge implements AudioOutputPort {
  readonly port_id = 'coreaudio-output';
  private process: ManagedProcessHandle['child'] | null = null;
  private resourceId: string | null = null;
  private opened = false;
  private closing = false;
  private status: AudioRouteHealth['status'] = 'closed';
  private reason: string | undefined;
  private selectedDevice: AudioDeviceDescriptor | undefined;
  private format: AudioFormat | undefined;
  private metricsValue: AudioRouteMetrics = {
    audio_chunks_in: 0,
    audio_chunks_out: 0,
    dropped_chunks: 0,
    dropped_ms: 0,
    underrun_count: 0,
    resampled: false,
  };
  private readonly writtenChunks: AudioChunk[] = [];

  constructor(private readonly options: CoreAudioOutputBridgeOptions = {}) {}

  async probe(): Promise<AudioRouteProbe> {
    const inventory = this.options.inventory_bridge ?? createCoreAudioDeviceInventoryBridge();
    const result = await inventory.probe();
    const outputs = result.devices.filter(
      (device) => device.direction === 'output' || device.direction === 'duplex'
    );
    return {
      route_id: this.port_id,
      bus_id: 'blackhole',
      available: result.available && outputs.length > 0,
      ...(outputs.length === 0
        ? { reason: result.reason || 'no CoreAudio output devices found' }
        : {}),
      devices: outputs,
    };
  }

  async open(format: AudioFormat, device: AudioDeviceDescriptor): Promise<AudioFormat> {
    if (this.opened) return this.format as AudioFormat;
    if (process.platform !== 'darwin') throw new Error('CoreAudio output requires macOS');
    if (format.encoding !== 'pcm_s16le') {
      throw new Error(`CoreAudio output supports pcm_s16le only; got ${format.encoding}`);
    }
    if (device.direction !== 'output' && device.direction !== 'duplex') {
      throw new Error(`device '${device.display_name}' is not an output device`);
    }
    if (device.channel_count !== undefined && format.channels > device.channel_count) {
      throw new Error(
        `device '${device.display_name}' supports ${device.channel_count} channel(s), requested ${format.channels}`
      );
    }
    if (
      device.supported_sample_rates?.length &&
      !device.supported_sample_rates.includes(format.sample_rate_hz)
    ) {
      throw new Error(
        `device '${device.display_name}' does not support ${format.sample_rate_hz}Hz; resampling is not implicit`
      );
    }
    const swift = this.options.swift_bin ?? 'swift';
    const script =
      this.options.script_path ?? rootResolve('libs/core/coreaudio-output-bridge.swift');
    const deviceArg = device.uid.startsWith('label:')
      ? ['--label', device.display_name]
      : ['--uid', device.uid];
    const resourceId = `audio:coreaudio-output:${device.uid}:${Date.now()}`;
    const managed = spawnManagedProcess({
      resourceId,
      kind: 'service',
      ownerId: device.uid,
      ownerType: 'coreaudio-output-bridge',
      command: swift,
      args: [
        script,
        ...deviceArg,
        '--sample-rate',
        String(format.sample_rate_hz),
        '--channels',
        String(format.channels),
      ],
      spawnOptions: {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeExecEnv({ KYBERION_AUDIO_DEVICE_UID: device.uid }),
      },
      shutdownPolicy: 'manual',
    });
    const child = managed.child;
    this.process = child;
    this.resourceId = resourceId;
    this.selectedDevice = device;
    this.format = format;
    this.opened = true;
    this.status = 'healthy';
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim();
      if (text) this.reason = text.slice(-1000);
    });
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim();
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isRecord(parsed) && typeof parsed.underrun_count === 'number') {
            this.metricsValue.underrun_count = parsed.underrun_count;
          }
        } catch {
          this.reason = `CoreAudio helper returned invalid JSON: ${text.slice(0, 200)}`;
        }
      }
    });
    child.on('error', (error) => this.markFailed(error.message));
    child.on('exit', (code, signal) => {
      if (!this.closing && (code !== 0 || signal !== null)) {
        this.markFailed(
          `CoreAudio output helper exited code=${String(code)} signal=${String(signal)}`
        );
      }
    });
    await waitForStartup(child, this.options.startup_timeout_ms ?? 250);
    return format;
  }

  async write(chunk: AudioChunk): Promise<void> {
    if (!this.opened || !this.process?.stdin || !this.format)
      throw new Error('CoreAudio output is not open');
    if (this.status === 'failed' || this.status === 'closed')
      throw new Error(this.reason || 'CoreAudio output is unavailable');
    if (
      chunk.format.encoding !== this.format.encoding ||
      chunk.format.sample_rate_hz !== this.format.sample_rate_hz ||
      chunk.format.channels !== this.format.channels
    ) {
      throw new Error('CoreAudio output received an audio format mismatch');
    }
    const payload = Buffer.from(chunk.payload);
    if (!this.process.stdin.write(payload)) {
      await onceDrain(this.process.stdin);
    }
    this.metricsValue.audio_chunks_out += 1;
    this.lastOutputAt = Date.now();
    this.writtenChunks.push(chunk);
    const signal = pcmSignalMetrics(this.writtenChunks.slice(-1));
    this.metricsValue.output_peak_rms = Math.max(
      this.metricsValue.output_peak_rms || 0,
      signal.input_peak_rms || 0
    );
    this.metricsValue.clipping_ratio = signal.clipping_ratio;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.process;
    if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
    if (child && child.exitCode === null && child.signalCode === null) {
      await waitForClose(child, this.options.cleanup_timeout_ms ?? 1500);
      if (child.exitCode === null && child.signalCode === null) terminateProcessGroup(child);
    }
    this.process = null;
    if (this.resourceId) stopManagedProcess(this.resourceId, child);
    this.resourceId = null;
    this.opened = false;
    this.status = 'closed';
  }

  health(): AudioRouteHealth {
    const alive = Boolean(
      this.process && this.process.exitCode === null && this.process.signalCode === null
    );
    return {
      status: this.status,
      input_process_alive: false,
      output_process_alive: alive,
      queue_depth: 0,
      dropped_chunks: this.metricsValue.dropped_chunks,
      underrun_count: this.metricsValue.underrun_count,
      device_disconnected: this.status === 'failed',
      lease_held: this.opened,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  metrics(): AudioRouteMetrics {
    return { ...this.metricsValue };
  }

  get device(): AudioDeviceDescriptor | undefined {
    return this.selectedDevice;
  }
  get outputLastChunkAtMs(): number | undefined {
    return this.lastOutputAt;
  }
  private lastOutputAt: number | undefined;

  private markFailed(message: string): void {
    if (this.closing) return;
    this.status = 'failed';
    this.reason = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function waitForStartup(child: ManagedProcessHandle['child'], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `CoreAudio output helper exited during startup code=${String(code)} signal=${String(signal)}`
        )
      );
    });
  });
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

function waitForClose(child: ManagedProcessHandle['child'], timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function terminateProcessGroup(child: ManagedProcessHandle['child']): void {
  if (typeof child.pid !== 'number') return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const hardKill = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }, 500);
  hardKill.unref();
}
