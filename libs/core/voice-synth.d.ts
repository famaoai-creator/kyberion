export interface SpeakOptions {
    voice?: string;
    rate?: number;
}
/**
 * Synthesizes speech using the OS's native TTS capabilities via Platform Abstraction.
 */
export declare function speak(text: string, options?: SpeakOptions): Promise<void>;
/**
 * A non-blocking wrapper to trigger speech without awaiting.
 */
export declare function say(text: string, options?: SpeakOptions): void;
//# sourceMappingURL=voice-synth.d.ts.map