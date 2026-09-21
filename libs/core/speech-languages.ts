/**
 * Speech language helpers shared by the file, streaming and voice-hub STT
 * seams: which languages a backend declares, and whether a requested
 * BCP-47 language is among them.
 */

/**
 * Languages of the multilingual Whisper models (large-v3 / turbo tokenizer),
 * shared by every Whisper-family backend (WhisperKit, mlx-whisper,
 * faster-whisper, whisper.cpp).
 */
export const WHISPER_LANGUAGES: readonly string[] = Object.freeze(
  (
    'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no ' +
    'th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw ' +
    'gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl ' +
    'mg as tt haw ln ha ba jw su yue'
  ).split(' ')
);

/** Primary language subtag of a BCP-47 tag (`ja-JP` → `ja`); empty when unset. */
export function primaryLanguageSubtag(language: string | undefined): string {
  return (
    String(language || '')
      .trim()
      .toLowerCase()
      .split(/[-_]/u)[0] ?? ''
  );
}

/**
 * Whether a backend that declares `languages` can transcribe `language`.
 * Undeclared languages (unknown) and an unset request are never filtered.
 */
export function supportsSpeechLanguage(
  languages: readonly string[] | undefined,
  language: string | undefined
): boolean {
  const wanted = primaryLanguageSubtag(language);
  if (!wanted || !languages) return true;
  return languages.some((entry) => primaryLanguageSubtag(entry) === wanted);
}
