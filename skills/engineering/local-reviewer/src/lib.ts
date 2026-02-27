import { safeExec } from '@agent/core/secure-io';

export interface ReviewContext {
  diff: string;
  status: 'has_changes' | 'no_changes' | 'error';
  message?: string;
  instructions?: string[];
}

export function getStagedDiff(): ReviewContext {
  try {
    const diff = safeExec('git', ['diff', '--staged', '--unified=3']);

    if (!diff.trim()) {
      return {
        status: 'no_changes',
        message: "No staged changes found. Did you run 'git add'?",
        diff: '',
      };
    }

    return {
      status: 'has_changes',
      diff,
      instructions: [
        'Review the above diff for:',
        '1. Bugs or logic errors.',
        '2. Security vulnerabilities.',
        '3. Code style consistency.',
        '4. Missing tests.',
      ],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: 'error', message: `Failed to run git diff: ${msg}`, diff: '' };
  }
}
