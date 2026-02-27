const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';

export interface HealingRule {
  id: string;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low';
  diagnosis: string;
  action: string;
  category: string;
}

export interface HealingAction {
  ruleId: string;
  severity: string;
  category: string;
  diagnosis: string;
  proposedAction: string;
  triggerLine: string;
}

export const HEALING_RUNBOOK: HealingRule[] = [
  {
    id: 'npm-missing-module',
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    severity: 'medium',
    diagnosis: 'Missing Node.js dependency',
    action: 'npm install',
    category: 'dependency',
  },
  {
    id: 'econnrefused',
    pattern: /ECONNREFUSED|Connection refused/i,
    severity: 'high',
    diagnosis: 'Service connection refused - target service may be down',
    action: 'Check if the target service is running. Restart if needed.',
    category: 'connectivity',
  },
  {
    id: 'enospc',
    pattern: /ENOSPC|No space left/i,
    severity: 'critical',
    diagnosis: 'Disk space exhausted',
    action: 'Free disk space: remove old logs, clean docker images, clear tmp',
    category: 'infrastructure',
  },
  {
    id: 'oom',
    pattern: /out of memory|heap|ENOMEM/i,
    severity: 'critical',
    diagnosis: 'Out of memory error',
    action: 'Increase memory allocation or optimize memory usage. Check for memory leaks.',
    category: 'infrastructure',
  },
  {
    id: 'timeout',
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    severity: 'medium',
    diagnosis: 'Operation timed out',
    action:
      'Check network connectivity, increase timeout values, or investigate slow dependencies.',
    category: 'connectivity',
  },
  {
    id: 'permission',
    pattern: /EACCES|Permission denied|EPERM/i,
    severity: 'medium',
    diagnosis: 'Permission denied',
    action:
      'Check file/directory permissions. Ensure the process runs with appropriate user privileges.',
    category: 'permissions',
  },
  {
    id: 'port-in-use',
    pattern: /EADDRINUSE|address already in use/i,
    severity: 'medium',
    diagnosis: 'Port already in use',
    action: 'Kill the process using the port or use a different port.',
    category: 'infrastructure',
  },
  {
    id: 'db-connection',
    pattern: /database.*connect|ECONNRESET.*db|connection.*pool/i,
    severity: 'high',
    diagnosis: 'Database connection failure',
    action: 'Check database credentials, network access, and connection pool configuration.',
    category: 'database',
  },
  {
    id: 'syntax-error',
    pattern: /SyntaxError|Unexpected token/i,
    severity: 'high',
    diagnosis: 'Code or configuration syntax error',
    action: 'Check recently changed files for syntax issues. Run linter.',
    category: 'code',
  },
  {
    id: 'cert-error',
    pattern: /CERT_|certificate|ssl|TLS/i,
    severity: 'high',
    diagnosis: 'SSL/TLS certificate issue',
    action: 'Check certificate expiry, chain, and trust store configuration.',
    category: 'security',
  },
];

export function parseInput(inputPath: string): string[] {
  const content = safeReadFile(inputPath, 'utf8');

  try {
    const json = JSON.parse(content);
    const errors: string[] = [];
    if (json.logAnalysis && json.logAnalysis.recentErrors) {
      errors.push(...json.logAnalysis.recentErrors);
    }
    if (json.error && json.error.message) {
      errors.push(json.error.message);
    }
    if (json.incident && json.incident.immediateActions) {
      errors.push(...json.incident.immediateActions);
    }
    if (errors.length > 0) return errors;
  } catch (_e) {
    // not JSON
  }

  return content
    .split(new RegExp('\\r?\\n'))
    .filter((line: string) => /error|exception|fatal|critical|fail/i.test(line))
    .map((line: string) => line.trim())
    .filter(Boolean)
    .slice(-100);
}

export function matchRunbook(errors: string[]): HealingAction[] {
  const matches: HealingAction[] = [];
  const matched = new Set<string>();

  for (const error of errors) {
    for (const rule of HEALING_RUNBOOK) {
      if (rule.pattern.test(error) && !matched.has(rule.id)) {
        matched.add(rule.id);
        matches.push({
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          diagnosis: rule.diagnosis,
          proposedAction: rule.action,
          triggerLine: error.substring(0, 200),
        });
      }
    }
  }

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return matches.sort(
    (a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3)
  );
}

/**
 * 究極の「完全自走モード」：テスト失敗ログからAIが直接コードを書き換え、再テストするループ。
 */
export async function autoHealTestFailure(testLogPath: string, sourcePath: string): Promise<any> {
  console.log(`[Self-Healing] Analyzing test failures from ${testLogPath}...`);
  const logContent = safeReadFile(testLogPath, 'utf8');
  const sourceContent = safeReadFile(sourcePath, 'utf8');

  const prompt = `
あなたは（The Focused Craftsman）として、以下のテスト失敗を自動修復します。

【対象ソースコード】:
\`\`\`
${sourceContent}
\`\`\`

【テスト失敗ログ】:
\`\`\`
${logContent}
\`\`\`

エラーを解決するための、修正後の完全なソースコードのみを出力してください。Markdownのコードブロック（\`\`\`）で囲むこと。
  `.trim();

  try {
    const { safeExec } = require('@agent/core/secure-io');
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    console.log('[Self-Healing] Consulting AI for a fix...');
    const aiOutput = safeExec('gemini', ['--prompt', escapedPrompt], { timeoutMs: 60000 });
    
    let fixedCode = aiOutput;
    const match = aiOutput.match(/```(?:javascript|typescript|js|ts)?\n([\s\S]*?)```/);
    if (match) {
      fixedCode = match[1].trim();
    }

    // Apply the fix directly
    console.log(`[Self-Healing] Applying patch to ${sourcePath}...`);
    safeWriteFile(sourcePath, fixedCode);

    // Re-run test
    console.log('[Self-Healing] Re-running tests...');
    const testCmd = safeExec('npm', ['run', 'test'], { cwd: require('path').dirname(sourcePath) });
    
    return {
      status: 'healed',
      patchApplied: true,
      newTestResult: 'passed',
      testOutput: testCmd
    };

  } catch (err: any) {
    return {
      status: 'failed',
      patchApplied: false,
      error: err.message
    };
  }
}
