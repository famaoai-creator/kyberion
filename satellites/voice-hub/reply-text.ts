/** Reply text shaping for voice-hub speech output. */
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { getVoiceTtsLanguageConfig } from '@agent/core/voice/voice-tts-config';

export function detectReplyLanguage(text: string): 'ja' | 'en' {
  return /[ぁ-んァ-ン一-龯]/.test(text) ? 'ja' : 'en';
}

export function normalizeTextForTts(text: string, language: SupportedLocale): string {
  const profile = getVoiceTtsLanguageConfig(language);
  const compact = text
    .replace(/\s+/g, ' ')
    .replace(
      /REQ-[A-Z0-9-]+/g,
      profile.requestIdToken || (language === 'ja' ? 'リクエストID' : 'request id')
    )
    .replace(/https?:\/\/\S+/g, profile.urlToken || (language === 'ja' ? 'URL' : 'link'))
    .trim();

  if (!compact) return text;

  if (language === 'ja') {
    return compact
      .replace(/([。！？])/g, '$1 ')
      .replace(/、/g, '、 ')
      .replace(/([0-9])件/g, '$1 件')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return compact
    .replace(/([.!?])/g, '$1 ')
    .replace(/,/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}
