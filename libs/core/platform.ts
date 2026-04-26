import * as os from 'node:os';
import { logger, safeExec } from './index.js';

/**
 * Platform Abstraction Layer
 * [SECURE-IO COMPLIANT VERSION]
 */

export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';

export interface PlatformCapabilities {
  hasSpeech: boolean;
  hasScreenCapture: boolean;
  hasAudioPlayback: boolean;
  hasFFmpeg: boolean;
  nativeTerminal: string;
}

/**
 * Checks if a command exists in the system path safely.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    const checkCmd = os.platform() === 'win32' ? 'where' : 'which';
    await safeExec(checkCmd, [cmd]);
    return true;
  } catch (_) {
    return false;
  }
}

export interface OSDriver {
  captureScreen(outputPath: string): Promise<void>;
  speak(text: string, options?: { voice?: string; rate?: number }): Promise<void>;
  playSound(path: string): Promise<void>;
  open(target: string): Promise<void>;
  getCapabilities(): Promise<PlatformCapabilities>;
  checkBinary(cmd: string): Promise<boolean>;
  runMediaCommand(tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string>;
}

/**
 * macOS Implementation
 */
class MacOSDriver implements OSDriver {
  async checkBinary(cmd: string): Promise<boolean> {
    return await commandExists(cmd);
  }

  async captureScreen(outputPath: string): Promise<void> {
    if (!(await commandExists('screencapture'))) throw new Error('screencapture not found');
    await safeExec('screencapture', ['-x', '-t', 'jpg', outputPath]);
  }

  async speak(text: string, options?: { voice?: string; rate?: number }): Promise<void> {
    if (!(await commandExists('say'))) return;
    const args = [text];
    if (options?.voice) { args.push('-v', options.voice); }
    if (options?.rate) { args.push('-r', String(options.rate)); }
    await safeExec('say', args);
  }

  async playSound(path: string): Promise<void> {
    if (!(await commandExists('afplay'))) return;
    await safeExec('afplay', [path]);
  }

  async open(target: string): Promise<void> {
    await safeExec('open', [target]);
  }

  async getCapabilities(): Promise<PlatformCapabilities> {
    return {
      hasSpeech: await commandExists('say'),
      hasScreenCapture: await commandExists('screencapture'),
      hasAudioPlayback: await commandExists('afplay'),
      hasFFmpeg: await commandExists('ffmpeg'),
      nativeTerminal: 'Terminal.app'
    };
  }

  async runMediaCommand(tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
    if (!(await this.checkBinary(tool))) {
      throw new Error(`${tool} not found. Please install via 'brew install ffmpeg'`);
    }
    return safeExec(tool, args);
  }
}

/**
 * Windows Implementation
 */
class WindowsDriver implements OSDriver {
  async checkBinary(cmd: string): Promise<boolean> {
    return await commandExists(cmd);
  }

  async captureScreen(): Promise<void> {
    logger.warn('[Platform] Screen capture not yet implemented for Windows.');
  }

  async speak(text: string): Promise<void> {
    await safeExec('powershell', ['-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`]);
  }

  async playSound(path: string): Promise<void> {
    await safeExec('powershell', ['-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`]);
  }

  async open(target: string): Promise<void> {
    await safeExec('start', [target]);
  }

  async getCapabilities(): Promise<PlatformCapabilities> {
    return {
      hasSpeech: true,
      hasScreenCapture: false,
      hasAudioPlayback: true,
      hasFFmpeg: await commandExists('ffmpeg'),
      nativeTerminal: 'powershell.exe'
    };
  }

  async runMediaCommand(tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
    if (!(await this.checkBinary(tool))) {
      throw new Error(`${tool} not found. Please install ffmpeg and add it to your PATH.`);
    }
    return safeExec(tool, args);
  }
}

/**
 * Linux Implementation
 */
class LinuxDriver implements OSDriver {
  async checkBinary(cmd: string): Promise<boolean> {
    return await commandExists(cmd);
  }

  async captureScreen(outputPath: string): Promise<void> {
    await safeExec('import', ['-window', 'root', outputPath]);
  }

  async speak(text: string): Promise<void> {
    await safeExec('espeak', [text]);
  }

  async playSound(path: string): Promise<void> {
    await safeExec('aplay', [path]);
  }

  async open(target: string): Promise<void> {
    await safeExec('xdg-open', [target]);
  }

  async getCapabilities(): Promise<PlatformCapabilities> {
    return {
      hasSpeech: await commandExists('espeak'),
      hasScreenCapture: await commandExists('import'),
      hasAudioPlayback: await commandExists('aplay'),
      hasFFmpeg: await commandExists('ffmpeg'),
      nativeTerminal: 'xterm'
    };
  }

  async runMediaCommand(tool: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
    if (!(await this.checkBinary(tool))) {
      throw new Error(`${tool} not found. Please install via 'sudo apt install ffmpeg'`);
    }
    return safeExec(tool, args);
  }
}

class UnknownDriver implements OSDriver {
  async checkBinary(): Promise<boolean> { return false; }
  async captureScreen() {}
  async speak() {}
  async playSound() {}
  async open() {}
  async getCapabilities(): Promise<PlatformCapabilities> {
    return { hasSpeech: false, hasScreenCapture: false, hasAudioPlayback: false, hasFFmpeg: false, nativeTerminal: 'sh' };
  }
  async runMediaCommand(): Promise<string> { throw new Error('Unsupported platform'); }
}

/**
 * Factory to get the current platform driver
 */
export function getPlatformDriver(): OSDriver {
  const p = os.platform();
  if (p === 'darwin') return new MacOSDriver();
  if (p === 'win32') return new WindowsDriver();
  if (p === 'linux') return new LinuxDriver();
  return new UnknownDriver();
}

export const platform = getPlatformDriver();
export const currentPlatform: Platform = os.platform() as Platform;
