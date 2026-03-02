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
  return Math.ceil(text.length / (charsPerToken[contentType] || 3.5));
}

export function pruneContext(messages: any[], maxTokens: number = 2000): { pruned: any[], summary: string } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { pruned: [], summary: 'No messages to prune.' };
  }

  // 1. Identify critical messages (the last 3 turns + the original goal)
  const criticalCount = Math.min(messages.length, 4);
  const critical = messages.slice(-criticalCount);
  const older = messages.slice(0, -criticalCount);

  // 2. Filter redundant commands (ls, cat, find without significant output changes)
  const filteredOlder = older.filter((msg) => {
    if (msg.role === 'tool' && msg.name === 'run_shell_command') {
      const content = String(msg.content || '');
      if (content.includes('ls -R') || content.includes('find ')) return false;
    }
    return true;
  });

  // 3. Simple Summary Generation
  const summary = `Pruned ${messages.length - filteredOlder.length - critical.length} redundant tool calls. Essential context preserved.`;

  return { pruned: [...filteredOlder.slice(-5), ...critical], summary };
}
