"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentPlatform = exports.platform = void 0;
exports.getPlatformDriver = getPlatformDriver;
const os = __importStar(require("node:os"));
const index_js_1 = require("./index.js");
/**
 * Checks if a command exists in the system path safely.
 */
async function commandExists(cmd) {
    try {
        const checkCmd = os.platform() === 'win32' ? 'where' : 'which';
        await (0, index_js_1.safeExec)(checkCmd, [cmd]);
        return true;
    }
    catch (_) {
        return false;
    }
}
/**
 * macOS Implementation
 */
class MacOSDriver {
    async captureScreen(outputPath) {
        if (!(await commandExists('screencapture')))
            throw new Error('screencapture not found');
        await (0, index_js_1.safeExec)('screencapture', ['-x', '-t', 'jpg', outputPath]);
    }
    async speak(text, options) {
        if (!(await commandExists('say')))
            return;
        const args = [text];
        if (options?.voice) {
            args.push('-v', options.voice);
        }
        if (options?.rate) {
            args.push('-r', String(options.rate));
        }
        await (0, index_js_1.safeExec)('say', args);
    }
    async playSound(path) {
        if (!(await commandExists('afplay')))
            return;
        await (0, index_js_1.safeExec)('afplay', [path]);
    }
    async open(target) {
        await (0, index_js_1.safeExec)('open', [target]);
    }
    async getCapabilities() {
        return {
            hasSpeech: await commandExists('say'),
            hasScreenCapture: await commandExists('screencapture'),
            hasAudioPlayback: await commandExists('afplay'),
            nativeTerminal: 'Terminal.app'
        };
    }
}
/**
 * Windows Implementation
 */
class WindowsDriver {
    async captureScreen() {
        index_js_1.logger.warn('[Platform] Screen capture not yet implemented for Windows.');
    }
    async speak(text) {
        await (0, index_js_1.safeExec)('powershell', ['-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`]);
    }
    async playSound(path) {
        await (0, index_js_1.safeExec)('powershell', ['-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`]);
    }
    async open(target) {
        await (0, index_js_1.safeExec)('start', [target]);
    }
    async getCapabilities() {
        return {
            hasSpeech: true,
            hasScreenCapture: false,
            hasAudioPlayback: true,
            nativeTerminal: 'powershell.exe'
        };
    }
}
/**
 * Linux Implementation
 */
class LinuxDriver {
    async captureScreen(outputPath) {
        await (0, index_js_1.safeExec)('import', ['-window', 'root', outputPath]);
    }
    async speak(text) {
        await (0, index_js_1.safeExec)('espeak', [text]);
    }
    async playSound(path) {
        await (0, index_js_1.safeExec)('aplay', [path]);
    }
    async open(target) {
        await (0, index_js_1.safeExec)('xdg-open', [target]);
    }
    async getCapabilities() {
        return {
            hasSpeech: await commandExists('espeak'),
            hasScreenCapture: await commandExists('import'),
            hasAudioPlayback: await commandExists('aplay'),
            nativeTerminal: 'xterm'
        };
    }
}
class UnknownDriver {
    async captureScreen() { }
    async speak() { }
    async playSound() { }
    async open() { }
    async getCapabilities() {
        return { hasSpeech: false, hasScreenCapture: false, hasAudioPlayback: false, nativeTerminal: 'sh' };
    }
}
/**
 * Factory to get the current platform driver
 */
function getPlatformDriver() {
    const p = os.platform();
    if (p === 'darwin')
        return new MacOSDriver();
    if (p === 'win32')
        return new WindowsDriver();
    if (p === 'linux')
        return new LinuxDriver();
    return new UnknownDriver();
}
exports.platform = getPlatformDriver();
exports.currentPlatform = os.platform();
