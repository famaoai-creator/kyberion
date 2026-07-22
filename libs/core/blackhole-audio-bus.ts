/**
 * BlackHole 2ch route.
 *
 * Capture remains an AVFoundation input because ffmpeg is a useful, portable
 * PCM capture adapter. Output deliberately does not use ffmpeg AVFoundation:
 * macOS ffmpeg builds are not a reliable CoreAudio output implementation.
 * PCM is sent to a UID-selected CoreAudio AudioQueue helper instead.
 */

import { logger } from './core.js';
import { buildSafeExecEnv, safeExecResult } from './secure-io.js';
import {
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from './managed-process.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';
import type { AudioBus, AudioBusProbe } from './audio-bus.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import {
  createCoreAudioDeviceInventoryBridge,
  resolveAudioDevice,
  type CoreAudioDeviceInventoryBridge,
} from './coreaudio-device-inventory.js';
import { CoreAudioOutputBridge } from './coreaudio-output-bridge.js';
import { BoundedAudioQueue, DEFAULT_AUDIO_BUFFER_POLICY } from './bounded-audio-queue.js';
import {
  pcmSignalMetrics,
  type AudioBufferPolicy,
  type AudioDeviceDescriptor,
  type AudioRouteHealth,
  type AudioRouteMetrics,
} from './audio-route.js';
import type { AudioOutputPort } from './audio-route.js';
import { AudioDeviceLeaseManager, type AudioDeviceLease } from './audio-device-lease.js';

export interface BlackHoleBusOptions {
  /** Exact display label used only when no CoreAudio UID is available. */
  device_label?: string;
  input_device_uid?: string;
  output_device_uid?: string;
  expected_device_label?: string;
  ffmpeg_bin?: string;
  ffmpeg_runner?: (
    command: string,
    args: string[]
  ) => {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
  inventory_bridge?: CoreAudioDeviceInventoryBridge;
  output_bridge?: AudioOutputPort;
  buffer_policy?: AudioBufferPolicy;
  startup_timeout_ms?: number;
  cleanup_timeout_ms?: number;
  session_id?: string;
  lease_ttl_ms?: number;
  lease_manager?: AudioDeviceLeaseManager;
}

const DEFAULT_DEVICE_LABEL = 'BlackHole 2ch';
const CAPTURE_CHUNK_MS = 20;

export class BlackHoleAudioBus implements AudioBus {
  readonly bus_id = 'blackhole' as const;
  private inputProc: ManagedProcessHandle['child'] | null = null;
  private inputResourceId: string | null = null;
  private opened = false;
  private closing = false;
  private format: AudioFormat | null = null;
  private inputDevice: AudioDeviceDescriptor | undefined;
  private outputDevice: AudioDeviceDescriptor | undefined;
  private inputQueue: BoundedAudioQueue | null = null;
  private pendingInput = Buffer.alloc(0);
  private status: AudioRouteHealth['status'] = 'closed';
  private reason: string | undefined;
  private readonly metricsValue: AudioRouteMetrics = {
    audio_chunks_in: 0,
    audio_chunks_out: 0,
    dropped_chunks: 0,
    dropped_ms: 0,
    underrun_count: 0,
    resampled: false,
  };
  private lastInputAt: number | undefined;
  private lastOutputAt: number | undefined;
  private readonly leaseManager: AudioDeviceLeaseManager;
  private readonly sessionId: string;
  private leases: AudioDeviceLease[] = [];

  constructor(private readonly opts: BlackHoleBusOptions = {}) {
    this.leaseManager = opts.lease_manager ?? new AudioDeviceLeaseManager();
    this.sessionId = opts.session_id ?? `blackhole-${process.pid}-${Date.now()}`;
  }

  async probe(): Promise<AudioBusProbe> {
    if (process.platform !== 'darwin') {
      return {
        bus_id: this.bus_id,
        available: false,
        reason: `BlackHole bus requires macOS; current platform is ${process.platform}`,
      };
    }
    const label = this.opts.expected_device_label ?? this.opts.device_label ?? DEFAULT_DEVICE_LABEL;
    const listing = this.ffmpegDeviceListing();
    const inventory = this.opts.inventory_bridge ?? createCoreAudioDeviceInventoryBridge();
    const inventoryProbe = await inventory.probe();
    const devices = inventoryProbe.devices;
    const input = resolveAudioDevice(devices, {
      uid: this.opts.input_device_uid,
      expected_label: label,
      direction: 'input',
    });
    const output = resolveAudioDevice(devices, {
      uid: this.opts.output_device_uid,
      expected_label: label,
      direction: 'output',
    });
    const inputDevice = input.descriptor ?? this.labelFallbackDevice(label, listing);
    const outputDevice = output.descriptor ?? this.labelFallbackDevice(label, listing);
    const warnings: string[] = [];
    if (
      input.used_fallback_label ||
      output.used_fallback_label ||
      inputDevice?.uid.startsWith('label:') ||
      outputDevice?.uid.startsWith('label:')
    ) {
      warnings.push(
        'CoreAudio UID was unavailable; exact label fallback is in use. Persist the UID when available.'
      );
    }
    const available = Boolean(inputDevice && outputDevice && listing.includes(label));
    const reason = available
      ? undefined
      : input.reason ||
        output.reason ||
        `device '${label}' was not found in the FFmpeg AVFoundation listing`;
    return {
      bus_id: this.bus_id,
      available,
      ...(reason ? { reason } : {}),
      devices: {
        ...(inputDevice ? { input: inputDevice.display_name } : {}),
        ...(outputDevice ? { output: outputDevice.display_name } : {}),
      },
      device_descriptors: [inputDevice, outputDevice].filter(
        (device, index, all): device is AudioDeviceDescriptor =>
          Boolean(device) && all.indexOf(device) === index
      ),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async open(format: AudioFormat): Promise<void> {
    if (this.opened) return;
    if (format.encoding !== 'pcm_s16le') {
      throw new Error(`[blackhole-audio-bus] only pcm_s16le is supported; got ${format.encoding}`);
    }
    const probe = await this.probe();
    if (!probe.available)
      throw new Error(`[blackhole-audio-bus] not available: ${probe.reason || 'unknown reason'}`);
    const label = this.opts.expected_device_label ?? this.opts.device_label ?? DEFAULT_DEVICE_LABEL;
    const descriptors = probe.device_descriptors ?? [];
    this.inputDevice =
      resolveAudioDevice(descriptors, {
        uid: this.opts.input_device_uid,
        expected_label: label,
        direction: 'input',
      }).descriptor ?? descriptors.find((device) => device.uid.startsWith('label:'));
    this.outputDevice =
      resolveAudioDevice(descriptors, {
        uid: this.opts.output_device_uid,
        expected_label: label,
        direction: 'output',
      }).descriptor ?? descriptors.find((device) => device.uid.startsWith('label:'));
    if (!this.inputDevice || !this.outputDevice)
      throw new Error('[blackhole-audio-bus] device resolution produced no input/output device');
    try {
      this.leases.push(
        this.leaseManager.acquire(
          this.inputDevice.uid,
          this.sessionId,
          this.opts.lease_ttl_ms ?? 30_000
        )
      );
      if (this.outputDevice.uid !== this.inputDevice.uid) {
        this.leases.push(
          this.leaseManager.acquire(
            this.outputDevice.uid,
            this.sessionId,
            this.opts.lease_ttl_ms ?? 30_000
          )
        );
      }
    } catch (error) {
      this.releaseLeases();
      throw error;
    }
    this.format = format;
    this.inputQueue = new BoundedAudioQueue(this.opts.buffer_policy ?? DEFAULT_AUDIO_BUFFER_POLICY);
    const ffmpeg = this.opts.ffmpeg_bin ?? 'ffmpeg';
    const channels = String(format.channels);
    const rate = String(format.sample_rate_hz);
    const captureDevice = this.inputDevice.display_name;
    const inputResourceId = `audio:blackhole-input:${this.sessionId}`;
    const managedInput = spawnManagedProcess({
      resourceId: inputResourceId,
      kind: 'service',
      ownerId: this.sessionId,
      ownerType: 'blackhole-audio-bus',
      command: ffmpeg,
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'avfoundation',
        '-i',
        `:${captureDevice}`,
        '-ac',
        channels,
        '-ar',
        rate,
        '-f',
        's16le',
        '-',
      ],
      spawnOptions: { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: buildSafeExecEnv() },
      shutdownPolicy: 'manual',
    });
    const inputProc = managedInput.child;
    this.inputResourceId = inputResourceId;
    this.inputProc = inputProc;
    inputProc.stdout?.on('data', (data: Buffer) => this.handleInbound(data));
    inputProc.stderr?.on('data', (data: Buffer) => {
      const message = data.toString('utf8').trim();
      if (message) logger._log('debug', `[blackhole input] ${message.slice(-1000)}`);
    });
    inputProc.on('error', (error) => this.markDegraded(`input process error: ${error.message}`));
    inputProc.on('exit', (code, signal) => {
      if (!this.closing) {
        this.markDegraded(`input process exited code=${String(code)} signal=${String(signal)}`);
      }
      this.inputQueue?.close();
    });

    const output =
      this.opts.output_bridge ??
      new CoreAudioOutputBridge({ inventory_bridge: this.opts.inventory_bridge });
    try {
      await waitForStartup(inputProc, this.opts.startup_timeout_ms ?? 250);
      await output.open(format, this.outputDevice);
    } catch (error) {
      await terminateProcess(inputProc, this.opts.cleanup_timeout_ms ?? 1500);
      stopManagedProcess(inputResourceId, inputProc);
      this.inputProc = null;
      this.inputQueue?.close();
      this.releaseLeases();
      throw error;
    }
    this.output = output;
    this.opened = true;
    this.status = 'healthy';
  }

  async *inputStream(): AsyncIterable<AudioChunk> {
    if (!this.opened || !this.inputQueue)
      throw new Error('[blackhole-audio-bus] open() before reading inputStream');
    while (!this.closing) {
      const chunk = await this.inputQueue.next();
      if (chunk === null) return;
      yield chunk;
    }
  }

  async writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
    if (!this.opened || !this.output || !this.format)
      throw new Error('[blackhole-audio-bus] open() before writeOutput');
    for await (const chunk of stream) {
      if (this.closing) return;
      if (!sameFormat(chunk.format, this.format))
        throw new Error('[blackhole-audio-bus] output PCM format mismatch');
      try {
        this.leases.forEach((lease) => lease.heartbeat());
        await this.output.write(chunk);
        this.metricsValue.audio_chunks_out += 1;
        this.lastOutputAt = Date.now();
      } catch (error) {
        this.markDegraded(
          `output failed: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    // Keep capture alive while the CoreAudio output helper drains its final
    // buffers. Stopping capture first can discard the tail of the loopback.
    await this.output?.close();
    this.output = null;
    this.closing = true;
    this.inputQueue?.close();
    if (this.inputProc) {
      await terminateProcess(this.inputProc, this.opts.cleanup_timeout_ms ?? 1500);
      if (this.inputResourceId) stopManagedProcess(this.inputResourceId, this.inputProc);
    }
    this.inputProc = null;
    this.inputResourceId = null;
    this.releaseLeases();
    this.opened = false;
    this.status = 'closed';
  }

  health(): AudioRouteHealth {
    const inputAlive = Boolean(
      this.inputProc && this.inputProc.exitCode === null && this.inputProc.signalCode === null
    );
    const outputHealth = this.output?.health();
    const queue = this.inputQueue?.metrics();
    const degraded =
      this.status === 'degraded' ||
      outputHealth?.status === 'failed' ||
      (!this.closing && this.opened && !inputAlive);
    return {
      status: this.closing ? 'closed' : degraded ? 'degraded' : this.status,
      input_process_alive: inputAlive,
      output_process_alive: outputHealth?.output_process_alive ?? false,
      ...(this.lastInputAt ? { last_input_chunk_at_ms: this.lastInputAt } : {}),
      ...(this.lastOutputAt ? { last_output_chunk_at_ms: this.lastOutputAt } : {}),
      queue_depth: queue?.depth ?? 0,
      dropped_chunks: queue?.dropped_chunks ?? 0,
      underrun_count: outputHealth?.underrun_count ?? this.metricsValue.underrun_count,
      device_disconnected: degraded,
      lease_held: this.leases.length > 0 && this.opened && !this.closing,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  metrics(): AudioRouteMetrics {
    const queue = this.inputQueue?.metrics();
    return {
      ...this.metricsValue,
      dropped_chunks: queue?.dropped_chunks ?? 0,
      dropped_ms: queue?.dropped_ms ?? 0,
      ...(this.output ? { underrun_count: this.output.metrics().underrun_count } : {}),
    };
  }

  private output: AudioOutputPort | null = null;

  private ffmpegDeviceListing(): string {
    const args = ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""'];
    const result = this.opts.ffmpeg_runner
      ? this.opts.ffmpeg_runner(this.opts.ffmpeg_bin ?? 'ffmpeg', args)
      : safeExecResult(this.opts.ffmpeg_bin ?? 'ffmpeg', args, {
          timeoutMs: 20_000,
          maxOutputMB: 2,
        });
    return `${result.stdout}\n${result.stderr}`;
  }

  private labelFallbackDevice(label: string, listing: string): AudioDeviceDescriptor | undefined {
    if (!listing.includes(label)) return undefined;
    return {
      uid: `label:${label}`,
      display_name: label,
      direction: 'duplex',
      channel_count: 2,
      is_virtual: true,
      avfoundation_unique_id: label,
    };
  }

  private handleInbound(data: Buffer): void {
    if (!this.format || !this.inputQueue) return;
    this.pendingInput = Buffer.concat([this.pendingInput, data]);
    const frameBytes = this.format.channels * 2;
    const chunkBytes = Math.max(
      frameBytes,
      Math.floor(this.format.sample_rate_hz * frameBytes * (CAPTURE_CHUNK_MS / 1000))
    );
    while (this.pendingInput.byteLength >= chunkBytes) {
      const payload = new Uint8Array(this.pendingInput.subarray(0, chunkBytes));
      this.pendingInput = this.pendingInput.subarray(chunkBytes);
      const chunk: AudioChunk = { format: this.format, payload, ts_ms: Date.now() };
      this.inputQueue.push(chunk);
      this.metricsValue.audio_chunks_in += 1;
      this.lastInputAt = Date.now();
      const signal = pcmSignalMetrics([chunk]);
      this.metricsValue.input_peak_rms = Math.max(
        this.metricsValue.input_peak_rms || 0,
        signal.input_peak_rms || 0
      );
      this.metricsValue.clipping_ratio = signal.clipping_ratio;
      this.metricsValue.silence_ratio = signal.silence_ratio;
    }
  }

  private markDegraded(message: string): void {
    if (this.closing) return;
    this.status = 'degraded';
    this.reason = message;
  }

  private releaseLeases(): void {
    for (const lease of this.leases.splice(0)) lease.release();
  }
}

function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sample_rate_hz === right.sample_rate_hz &&
    left.channels === right.channels
  );
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
          `BlackHole capture exited during startup code=${String(code)} signal=${String(signal)}`
        )
      );
    });
  });
}

async function terminateProcess(
  child: ManagedProcessHandle['child'],
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    /* already closed */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  });
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

registerEnvironmentCapabilityProbe('audio-bus.blackhole', async () =>
  new BlackHoleAudioBus().probe()
);
