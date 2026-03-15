import * as pathResolver from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeReadFile } from './secure-io.js';
import type { NerveMessage } from './nerve-bridge.js';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

export function loadRecentStimuli(limit: number): NerveMessage[] {
  if (!safeExistsSync(STIMULI_PATH)) return [];

  const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NerveMessage];
      } catch {
        return [];
      }
    });
}

export function appendStimulus(stimulus: NerveMessage): void {
  safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
}

export function stimuliJournalPath(): string {
  return STIMULI_PATH;
}
