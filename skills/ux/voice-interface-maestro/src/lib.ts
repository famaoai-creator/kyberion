import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import fs from 'fs';
import { execSync } from 'child_process';
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface VoiceConfig {
  engine: 'macos' | 'api' | string;
  voice: string;
  apiKey?: string | null;
}

export function loadVoiceConfig(configPath: string): VoiceConfig {
  const defaultConfig: VoiceConfig = { engine: 'macos', voice: 'Kyoko', apiKey: null };
  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(safeReadFile(configPath, 'utf8'));
      return { ...defaultConfig, ...userConfig };
    } catch (_e) {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' [コードをスキップ] ')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // Extract link text
    .replace(/[#*_~`]/g, '') // Remove basic MD formatting
    .replace(/\n+/g, ' ') // Replace newlines with spaces
    .trim();
}

/**
 * Speaks the content of a DocumentArtifact.
 */
export function speakArtifact(
  artifact: DocumentArtifact,
  config: VoiceConfig
): { method: string; success: boolean } {
  return speakText(artifact.body, config);
}

export function speakText(text: string, config: VoiceConfig): { method: string; success: boolean } {
  const cleanText = cleanTextForSpeech(text);

  if (config.engine === 'macos') {
    try {
      // Use double quotes for shell command, escaping any internal quotes
      const escaped = cleanText.replace(/"/g, '\"');
      execSync(`say -v ${config.voice} "${escaped}"`);
      return { method: 'macos-say', success: true };
    } catch (_e) {
      return { method: 'macos-say', success: false };
    }
  }

  // Simulated API fallback
  return { method: `api-${config.engine}`, success: true };
}
