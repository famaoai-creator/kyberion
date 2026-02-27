export function analyzeLogLines(lines: string[]): any {
  const errors: string[] = [];
  const patterns: Record<string, number> = {};

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) {
      errors.push(line.trim().substring(0, 100));
      const regex = new RegExp('(?:error|exception|fatal)[\\\\s:]+([^\\\\n]{5,50})', 'i');
      const match = line.match(regex);
      if (match) {
        const p = match[1].trim();
        patterns[p] = (patterns[p] || 0) + 1;
      }
    }
  }

  return {
    errorCount: errors.length,
    topPatterns: Object.entries(patterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
  };
}

/**
 * Generates a professional RCA (Root Cause Analysis) report using AI.
 */
export async function generateRCAReport(logContent: string): Promise<string> {
  const { safeExec } = require('@agent/core/secure-io');
  
  const prompt = `
あなたは（The Resilient Commander）として、以下の障害ログからプロフェッショナルな「障害報告書 (Post-Mortem)」を作成します。

【ミッション】: 根本原因の特定（5-Whys）と再発防止策の策定。
【報告書構成】:
1. Executive Summary
2. Timeline
3. Impact Analysis
4. Root Cause Analysis (5-Whys)
5. Action Items (Preventative Measures)

【対象ログ】:
\`\`\`
${logContent.substring(0, 5000)}
\`\`\`

Markdown形式で出力してください。
  `.trim();

  try {
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    console.error('[Crisis] Consulting AI for RCA analysis...');
    const report = safeExec('gemini', ['--prompt', escapedPrompt], { timeoutMs: 60000 });
    return report;
  } catch (err: any) {
    throw new Error(`RCA Generation Failed: ${err.message}`);
  }
}
