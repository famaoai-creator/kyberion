export const PRICING: any = {
  gpt4: { input: 0.03, output: 0.06 },
  'gpt4-turbo': { input: 0.01, output: 0.03 },
};

export function detectContentType(text: string): 'code' | 'prose' | 'mixed' {
  const lines = text.split(new RegExp('\\\\r?\\\\n'));
  if (lines.length === 0) return 'prose';
  let codeSignals = 0;
  for (const line of lines) {
    if (/[{};]/.test(line) || /^\\s*(import|const|let|var|function)\\b/.test(line)) codeSignals++;
  }
  const ratio = codeSignals / lines.length;
  if (ratio > 0.5) return 'code';
  if (ratio > 0.15) return 'mixed';
  return 'prose';
}

export function estimateTokens(text: string, contentType: 'code' | 'prose' | 'mixed'): number {
  const charsPerToken = { prose: 4, code: 2.5, mixed: 3 };
  return Math.ceil(text.length / charsPerToken[contentType]);
}
