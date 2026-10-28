import * as path from 'node:path';
import {
  safeExecResultAsync,
  safeReadFile,
  safeUnlinkSync,
  safeMkdir,
} from '@agent/core/secure-io';
import {
  resolveAdbBin,
  resolveAxeBin,
  resolveXcrunBin,
} from '@agent/core/tool/tool-binary-resolvers';

/**
 * FrameSource abstracts "one still frame from a device's screen".
 * grab() is async so the mirror's event loop stays responsive while a
 * capture exec is in flight; implementations are one-shot execs so the
 * capture backend (simctl/AXe today, SimulatorKit-grade streaming later) can
 * be swapped without changing mirror or actuator contracts.
 */
export interface FrameSource {
  readonly label: string;
  grab(): Promise<Buffer>;
}

export interface SimctlScreenshotSourceOptions {
  udid: string;
  scratchDir: string;
  timeoutMs?: number;
}

/**
 * iOS simulator frames. AXe is tried first: SimulatorKit runs in-process, so
 * it can write into the repo checkout — the CoreSimulator service behind
 * `simctl io screenshot` is sandboxed to the OS temp dir on some volumes
 * (observed: EPERM writing into /Volumes/data checkouts). simctl remains the
 * fallback for hosts without AXe.
 */
export class SimctlScreenshotSource implements FrameSource {
  readonly label: string;
  private readonly udid: string;
  private readonly scratchDir: string;
  private readonly timeoutMs: number;
  private frameSeq = 0;

  constructor(options: SimctlScreenshotSourceOptions) {
    this.udid = options.udid;
    this.scratchDir = options.scratchDir;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.label = `ios-simulator:${options.udid}`;
    safeMkdir(this.scratchDir, { recursive: true });
  }

  async grab(): Promise<Buffer> {
    const framePath = path.join(this.scratchDir, `frame-${this.frameSeq++ % 8}.png`);
    const axe = await safeExecResultAsync(
      resolveAxeBin(),
      ['screenshot', '--udid', this.udid, '--output', framePath],
      { timeoutMs: this.timeoutMs }
    );
    if (axe.status !== 0) {
      const simctl = await safeExecResultAsync(
        resolveXcrunBin(),
        ['simctl', 'io', this.udid, 'screenshot', '--type', 'png', framePath],
        { timeoutMs: this.timeoutMs }
      );
      if (simctl.status !== 0) {
        throw new Error(`screenshot failed: ${axe.stderr || simctl.stderr || 'unknown'}`);
      }
    }
    const frame = safeReadFile(framePath, { encoding: null });
    safeUnlinkSync(framePath);
    return frame as Buffer;
  }
}

export interface AdbScreencapSourceOptions {
  serial?: string;
  scratchDir: string;
  timeoutMs?: number;
}

export class AdbScreencapSource implements FrameSource {
  readonly label: string;
  private readonly serial: string;
  private readonly scratchDir: string;
  private readonly timeoutMs: number;
  private frameSeq = 0;

  constructor(options: AdbScreencapSourceOptions) {
    this.serial = options.serial ?? '';
    this.scratchDir = options.scratchDir;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.label = `android:${this.serial || 'default-device'}`;
    safeMkdir(this.scratchDir, { recursive: true });
  }

  private args(...rest: string[]): string[] {
    return [...(this.serial ? ['-s', this.serial] : []), ...rest];
  }

  async grab(): Promise<Buffer> {
    const remote = `/sdcard/kyberion-mirror-${this.frameSeq % 8}.png`;
    const local = path.join(this.scratchDir, `frame-${this.frameSeq++ % 8}.png`);
    try {
      const cap = await safeExecResultAsync(
        resolveAdbBin(),
        this.args('shell', 'screencap', '-p', remote),
        { timeoutMs: this.timeoutMs }
      );
      if (cap.status !== 0) {
        throw new Error(`screencap failed: ${cap.stderr || 'unknown'}`);
      }
      const pull = await safeExecResultAsync(resolveAdbBin(), this.args('pull', remote, local), {
        timeoutMs: this.timeoutMs,
      });
      if (pull.status !== 0) {
        throw new Error(`adb pull failed: ${pull.stderr || 'unknown'}`);
      }
      return safeReadFile(local, { encoding: null }) as Buffer;
    } finally {
      void safeExecResultAsync(resolveAdbBin(), this.args('shell', 'rm', '-f', remote), {
        timeoutMs: 5000,
      });
      try {
        safeUnlinkSync(local);
      } catch {
        /* frame may not have landed */
      }
    }
  }
}
