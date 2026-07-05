export const DEFAULT_LATIN_FONT = 'Inter';
export const DEFAULT_EAST_ASIA_FONT = 'Noto Sans JP';
export const DEFAULT_COMPLEX_SCRIPT_FONT = DEFAULT_EAST_ASIA_FONT;

export function normalizeFontFamily(input: string | undefined | null): string {
  return (
    String(input || '')
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .find((part) => part.length > 0) || ''
  );
}

function looksLikeJapaneseFont(fontFamily: string): boolean {
  return /^(Noto Sans JP|Noto Serif JP|Yu Gothic|YuGothic|Meiryo|MS Gothic|MS Mincho|Hiragino Sans|Hiragino Kaku Gothic ProN|BIZ UDP|Source Han Sans|Source Han Serif|M\+ 1p|M\+ 2p)/i.test(
    fontFamily
  );
}

export function resolveLatinFontFamily(
  input?: string | null,
  fallback = DEFAULT_LATIN_FONT
): string {
  const fontFamily = normalizeFontFamily(input);
  return fontFamily || fallback;
}

export function resolveEastAsiaFontFamily(
  input?: string | null,
  fallback = DEFAULT_EAST_ASIA_FONT
): string {
  const fontFamily = normalizeFontFamily(input);
  return fontFamily && looksLikeJapaneseFont(fontFamily) ? fontFamily : fallback;
}

export function resolveFontPair(input?: string | null): {
  latin: string;
  eastAsia: string;
  cs: string;
} {
  const latin = resolveLatinFontFamily(input);
  const eastAsia = resolveEastAsiaFontFamily(input);
  return { latin, eastAsia, cs: eastAsia };
}
