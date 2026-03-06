import * as os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './core.js';

const execAsync = promisify(exec);

export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';

export interface PlatformCapabilities {
  hasSpeech: boolean;
  hasScreenCapture: boolean;
  hasAudioPlayback: boolean;
  nativeTerminal: string;
}

export interface OSDriver {
  captureScreen(outputPath: string): Promise<void>;
  speak(text: string, options?: { voice?: string; rate?: number }): Promise<void>;
  playSound(path: string): Promise<void>;
  open(target: string): Promise<void>;
  getCapabilities(): PlatformCapabilities;
}

/**
 * macOS Implementation
 */
class MacOSDriver implements OSDriver {
  async captureScreen(outputPath: string): Promise<void> {
    await execAsync(`screencapture -x -t jpg "${outputPath}"`);
  }

  async speak(text: string, options?: { voice?: string; rate?: number }): Promise<void> {
    const sanitized = text.replace(/"/g, '').replace(/'/g, '');
    let cmd = `say "${sanitized}"`;
    if (options?.voice) cmd += ` -v ${options.voice}`;
    if (options?.rate) cmd += ` -r ${options.rate}`;
    await execAsync(cmd);
  }

  async playSound(path: string): Promise<void> {
    await execAsync(`afplay "${path}"`);
  }

  async open(target: string): Promise<void> {
    await execAsync(`open "${target}"`);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      hasSpeech: true,
      hasScreenCapture: true,
      hasAudioPlayback: true,
      nativeTerminal: 'Terminal.app'
    };
  }
}

/**
 * Windows Implementation (Stub)
 */
class WindowsDriver implements OSDriver {
  async captureScreen(_outputPath: string): Promise<void> {
    // Note: Windows requires external tools like SnippingTool or PowerShell scripts
    logger.warn('[Platform] Screen capture not yet implemented for Windows.');
  }

  async speak(text: string): Promise<void> {
    const sanitized = text.replace(/"/g, '').replace(/'/g, '');
    await execAsync(`powershell -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${sanitized}')"`);
  }

  async playSound(path: string): Promise<void> {
    await execAsync(`powershell -Command "(New-Object Media.SoundPlayer '${path}').PlaySync()"`);
  }

  async open(target: string): Promise<void> {
    await execAsync(`start "${target}"`);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      hasSpeech: true,
      hasScreenCapture: false,
      hasAudioPlayback: true,
      nativeTerminal: 'powershell.exe'
    };
  }
}

/**
 * Linux Implementation (Stub)
 */
class LinuxDriver implements OSDriver {
  async captureScreen(outputPath: string): Promise<void> {
    await execAsync(`import -window root "${outputPath}"`); // Requires ImageMagick
  }

  async speak(text: string): Promise<void> {
    const sanitized = text.replace(/"/g, '').replace(/'/g, '');
    await execAsync(`espeak "${sanitized}"`);
  }

  async playSound(path: string): Promise<void> {
    await execAsync(`aplay "${path}"`);
  }

  async open(target: string): Promise<void> {
    await execAsync(`xdg-open "${target}"`);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      hasSpeech: true,
      hasScreenCapture: true,
      hasAudioPlayback: true,
      nativeTerminal: 'xterm'
    };
  }
}

class UnknownDriver implements OSDriver {
  async captureScreen() {}
  async speak() {}
  async playSound() {}
  async open() {}
  getCapabilities(): PlatformCapabilities {
    return { hasSpeech: false, hasScreenCapture: false, hasAudioPlayback: false, nativeTerminal: 'sh' };
  }
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
