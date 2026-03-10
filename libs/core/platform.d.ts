/**
 * Platform Abstraction Layer
 * [SECURE-IO COMPLIANT VERSION]
 */
export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';
export interface PlatformCapabilities {
    hasSpeech: boolean;
    hasScreenCapture: boolean;
    hasAudioPlayback: boolean;
    nativeTerminal: string;
}
export interface OSDriver {
    captureScreen(outputPath: string): Promise<void>;
    speak(text: string, options?: {
        voice?: string;
        rate?: number;
    }): Promise<void>;
    playSound(path: string): Promise<void>;
    open(target: string): Promise<void>;
    getCapabilities(): Promise<PlatformCapabilities>;
}
/**
 * Factory to get the current platform driver
 */
export declare function getPlatformDriver(): OSDriver;
export declare const platform: OSDriver;
export declare const currentPlatform: Platform;
//# sourceMappingURL=platform.d.ts.map