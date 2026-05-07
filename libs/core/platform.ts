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
  captureFocusedWindow(outputPath: string): Promise<void>;
  listRunningApps(): Promise<string[]>;
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

  async captureFocusedWindow(outputPath: string): Promise<void> {
    if (!(await commandExists('osascript'))) throw new Error('osascript not found');
    if (!(await commandExists('screencapture'))) throw new Error('screencapture not found');

    const areaScript = 'tell application "System Events" to tell (first application process whose frontmost is true) to tell window 1 to return (item 1 of (get position) as text) & "," & (item 2 of (get position) as text) & "," & (item 1 of (get size) as text) & "," & (item 2 of (get size) as text)';
    let area = '';
    try {
      area = safeExec('osascript', ['-e', areaScript]).trim();
    } catch (err) {
      logger.warn(`[MacOSDriver] Failed to get focused window area: ${err}`);
    }

    if (!area || area.split(',').length !== 4) {
      logger.info('[MacOSDriver] No focused window area found, falling back to full screen capture.');
      return this.captureScreen(outputPath);
    }

    // Use -R (rect) for precise window capture based on coordinates
    await safeExec('screencapture', [`-R${area}`, '-x', '-t', 'jpg', outputPath]);
  }

  async listRunningApps(): Promise<string[]> {
    if (!(await commandExists('osascript'))) return [];
    const script = 'tell application "System Events" to get name of every application process whose background only is false';
    try {
      const output = safeExec('osascript', ['-e', script]);
      return output.split(',').map((s) => s.trim());
    } catch (err) {
      logger.warn(`[MacOSDriver] Failed to list running apps: ${err}`);
      return [];
    }
  }

  async speak(text: string, options?: { voice?: string; rate?: number }): Promise<void> {
    if (!(await commandExists('say'))) return;
    const args = [text];
    if (options?.voice) {
      args.push('-v', options.voice);
    }
    if (options?.rate) {
      args.push('-r', String(options.rate));
    }
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
      nativeTerminal: 'Terminal.app',
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

  async captureScreen(outputPath: string): Promise<void> {
    if (!(await commandExists('powershell'))) throw new Error('powershell not found');
    logger.warn('[Platform] Full screen capture via PowerShell GDI+ is experimental on Windows.');
    // Stub: complex PowerShell script for GDI+ capture could go here.
  }

  async captureFocusedWindow(outputPath: string): Promise<void> {
    logger.warn('[Platform] Focused window capture not yet implemented for Windows.');
  }

  async listRunningApps(): Promise<string[]> {
    if (!(await commandExists('powershell'))) return [];
    try {
      const script = 'Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty Name';
      const output = safeExec('powershell', ['-Command', script]);
      return output.split('\r\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      logger.warn(`[WindowsDriver] Failed to list running apps: ${err}`);
      return [];
    }
  }

  async speak(text: string): Promise<void> {
    await safeExec('powershell', [
      '-Command',
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`,
    ]);
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
      nativeTerminal: 'powershell.exe',
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

  async captureFocusedWindow(outputPath: string): Promise<void> {
    if (await commandExists('import') && await commandExists('xprop')) {
      try {
        const activeWindowId = safeExec('sh', ['-c', "xprop -root _NET_ACTIVE_WINDOW | awk '{print $5}'"]).trim();
        if (activeWindowId && activeWindowId !== '0x0') {
          await safeExec('import', ['-window', activeWindowId, outputPath]);
          return;
        }
      } catch (err) {
        logger.warn(`[LinuxDriver] Failed to get focused window ID via xprop: ${err}`);
      }
    }
    return this.captureScreen(outputPath);
  }

  async listRunningApps(): Promise<string[]> {
    if (await commandExists('wmctrl')) {
      try {
        const output = safeExec('wmctrl', ['-l']);
        return output.split('\n').map((line) => {
          const parts = line.split(/\s+/);
          return parts.slice(3).join(' '); // App title is usually from 4th column onwards
        }).filter(Boolean);
      } catch (err) {
        logger.warn(`[LinuxDriver] Failed to list running apps via wmctrl: ${err}`);
      }
    }
    return [];
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
      nativeTerminal: 'xterm',
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
  async checkBinary(): Promise<boolean> {
    return false;
  }
  async captureScreen() {}
  async captureFocusedWindow() {}
  async listRunningApps(): Promise<string[]> {
    return [];
  }
  async speak() {}
  async playSound() {}
  async open() {}
  async getCapabilities(): Promise<PlatformCapabilities> {
    return {
      hasSpeech: false,
      hasScreenCapture: false,
      hasAudioPlayback: false,
      hasFFmpeg: false,
      nativeTerminal: 'sh',
    };
  }
  async runMediaCommand(): Promise<string> {
    throw new Error('Unsupported platform');
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
