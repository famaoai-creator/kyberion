import { platform } from './platform.js';

export interface SpeakOptions {
  voice?: string;
  rate?: number; // Words per minute
}

/**
 * Synthesizes speech using the OS's native TTS capabilities via Platform Abstraction.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  await platform.speak(text, options);
}

/**
 * A non-blocking wrapper to trigger speech without awaiting.
 */
export function say(text: string, options: SpeakOptions = {}): void {
  speak(text, options).catch(() => {});
}
