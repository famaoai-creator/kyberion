import { safeExecResult, safeExecResultAsync } from '@agent/core/secure-io';
import { resolveAdbBin, resolveAxeBin } from '@agent/core/tool/tool-binary-resolvers';

/**
 * InputInjector abstracts touch/keyboard injection into a running device.
 * iOS simulators go through AXe (SimulatorKit HID, iOS 26-safe); Android
 * goes through `adb shell input`. Both are replaceable behind the same
 * interface (e.g. XcodeBuildMCP or a managed-device cloud). Methods are
 * async so interactive paths never block the caller's event loop.
 */
export interface InputInjector {
  readonly label: string;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  inputText(text: string): Promise<void>;
  pressButton(name: string): Promise<void>;
}

export interface AxeInjectorOptions {
  udid: string;
  timeoutMs?: number;
}

export class AxeMissingError extends Error {
  constructor(detail: string) {
    super(
      `AXe is required for iOS UI interaction but was not found or failed: ${detail}. ` +
        `Install with: brew install cameroncooke/axe/axe`
    );
    this.name = 'AxeMissingError';
  }
}

export class AxeInjector implements InputInjector {
  readonly label: string;
  private readonly udid: string;
  private readonly timeoutMs: number;

  constructor(options: AxeInjectorOptions) {
    this.udid = options.udid;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.label = `ios-simulator:${options.udid}`;
  }

  static availability(timeoutMs = 10000): { available: boolean; version?: string; error?: string } {
    // safeExecResult, not safeExec: callers embed this probe inside health
    // checks, and actuator unit tests mock safeExec with fixed call
    // sequences — a probe through it would desynchronize every simctl op.
    try {
      const result = safeExecResult(resolveAxeBin(), ['--version'], { timeoutMs });
      if (result.status !== 0) {
        return {
          available: false,
          error: result.stderr || `exit ${result.status}`,
        };
      }
      return { available: true, version: result.stdout.trim() };
    } catch (error: unknown) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async run(args: string[]): Promise<string> {
    const result = await safeExecResultAsync(resolveAxeBin(), [...args, '--udid', this.udid], {
      timeoutMs: this.timeoutMs,
    });
    if (result.status !== 0) {
      const detail = result.stderr || result.error?.message || `exit ${result.status}`;
      if (/ENOENT|command not found|not found/i.test(detail)) throw new AxeMissingError(detail);
      throw new Error(`axe ${args[0]} failed: ${detail}`);
    }
    return result.stdout.trim();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.run(['tap', '-x', String(Math.round(x)), '-y', String(Math.round(y))]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.run([
      'swipe',
      '--start-x',
      String(Math.round(x1)),
      '--start-y',
      String(Math.round(y1)),
      '--end-x',
      String(Math.round(x2)),
      '--end-y',
      String(Math.round(y2)),
      // AXe takes seconds; fractional values are accepted.
      '--duration',
      String(Math.max(0.05, durationMs / 1000)),
    ]);
  }

  async inputText(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.run(['type', text]);
  }

  async pressButton(name: string): Promise<void> {
    const normalized = name.trim().toLowerCase();
    const allowed = new Set(['home', 'lock', 'siri', 'apple-pay']);
    if (!allowed.has(normalized)) {
      throw new Error(`press_button supports: ${[...allowed].join(', ')} (got "${name}")`);
    }
    await this.run(['button', normalized]);
  }

  async describeUi(): Promise<unknown> {
    const out = await this.run(['describe-ui']);
    try {
      return JSON.parse(out);
    } catch {
      return { raw: out };
    }
  }
}

export interface AdbInjectorOptions {
  serial?: string;
  timeoutMs?: number;
}

export class AdbInjector implements InputInjector {
  readonly label: string;
  private readonly serial: string;
  private readonly timeoutMs: number;

  constructor(options: AdbInjectorOptions = {}) {
    this.serial = options.serial ?? '';
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.label = `android:${this.serial || 'default-device'}`;
  }

  private async run(args: string[]): Promise<string> {
    const finalArgs = [...(this.serial ? ['-s', this.serial] : []), ...args];
    const result = await safeExecResultAsync(resolveAdbBin(), finalArgs, {
      timeoutMs: this.timeoutMs,
    });
    if (result.status !== 0) {
      throw new Error(
        `adb ${args.join(' ')} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`
      );
    }
    return result.stdout.trim();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.run([
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.max(0, Math.round(durationMs))),
    ]);
  }

  async inputText(text: string): Promise<void> {
    // `input text` re-parses through the remote shell: spaces become %s and
    // shell metacharacters must be backslash-escaped (not stripped, which
    // would corrupt passwords/punctuation).
    const escaped = text.replace(/ /g, '%s').replace(/([&<>|;$`"'\\()])/g, '\\$1');
    if (!escaped.trim()) return;
    await this.run(['shell', 'input', 'text', escaped]);
  }

  async pressButton(name: string): Promise<void> {
    const keymap: Record<string, string> = {
      home: 'KEYCODE_HOME',
      back: 'KEYCODE_BACK',
      lock: 'KEYCODE_POWER',
      'app-switch': 'KEYCODE_APP_SWITCH',
      enter: 'KEYCODE_ENTER',
    };
    const key = keymap[name.trim().toLowerCase()];
    if (!key) {
      throw new Error(`press_button supports: ${Object.keys(keymap).join(', ')} (got "${name}")`);
    }
    await this.run(['shell', 'input', 'keyevent', key]);
  }
}
