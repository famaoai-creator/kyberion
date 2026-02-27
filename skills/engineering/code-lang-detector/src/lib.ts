import path from 'path';

export const EXT_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'shell',
};

export const KEYWORDS: Record<string, string[]> = {
  python: ['def ', 'import ', 'print('],
  javascript: ['const ', 'function ', 'console.log'],
  java: ['public class ', 'System.out.println'],
  go: ['package main', 'fmt.Println'],
  rust: ['fn main', 'println!'],
};

export interface DetectResult {
  lang: string;
  confidence: number;
  method: 'extension' | 'keyword' | 'unknown';
}

export function detectLanguage(inputPath: string, content: string): DetectResult {
  // 1. Extension check
  // Handle case where inputPath is not a path but raw content (no extension)
  const ext = path.extname(inputPath).toLowerCase();
  if (ext && EXT_MAP[ext]) {
    return { lang: EXT_MAP[ext], confidence: 1.0, method: 'extension' };
  }

  // 2. Keyword check
  let bestLang = 'unknown';
  let maxScore = 0;

  for (const [lang, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    words.forEach((w) => {
      if (content.includes(w)) score++;
    });
    if (score > maxScore) {
      maxScore = score;
      bestLang = lang;
    }
  }

  if (maxScore > 0) {
    return { lang: bestLang, confidence: 0.8, method: 'keyword' };
  }

  return { lang: 'unknown', confidence: 0, method: 'unknown' };
}
