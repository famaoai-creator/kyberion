import {
  appleFmPrompt,
  classifyLocallyWithAppleFm,
  summarizeLocallyWithAppleFm,
} from './apple-intelligence-bridge.js';
import {
  classifyLocallyWithWindowsAi,
  summarizeLocallyWithWindowsAi,
  windowsLocalAssistPrompt,
} from './windows-local-assist-bridge.js';

export interface LocalAssistAdapter {
  prompt(
    text: string,
    options?: { instructions?: string; timeoutMs?: number }
  ): Promise<string | null>;
  classify(
    text: string,
    categories: string[],
    options?: { timeoutMs?: number }
  ): Promise<string | null>;
  summarize(text: string, options?: { timeoutMs?: number }): Promise<string | null>;
}

const appleAdapter: LocalAssistAdapter = {
  prompt: appleFmPrompt,
  classify: classifyLocallyWithAppleFm,
  summarize: summarizeLocallyWithAppleFm,
};

const windowsAdapter: LocalAssistAdapter = {
  prompt: windowsLocalAssistPrompt,
  classify: classifyLocallyWithWindowsAi,
  summarize: summarizeLocallyWithWindowsAi,
};

/** Resolve the provider-native local assist adapter without leaking OS checks to callers. */
export function resolveLocalAssistAdapter(): LocalAssistAdapter | null {
  if (process.platform === 'darwin') return appleAdapter;
  if (process.platform === 'win32') return windowsAdapter;
  return null;
}

export async function localAssistPrompt(
  text: string,
  options: { instructions?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  return (await resolveLocalAssistAdapter()?.prompt(text, options)) ?? null;
}

export async function classifyLocally(
  text: string,
  categories: string[],
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  return (await resolveLocalAssistAdapter()?.classify(text, categories, options)) ?? null;
}

export async function summarizeLocally(
  text: string,
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  return (await resolveLocalAssistAdapter()?.summarize(text, options)) ?? null;
}
