import { logger, safeWriteFile, pathResolver } from '@agent/core';
import { safeExec, safeUnlinkSync } from '@agent/core/secure-io';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Sentinel Check Utility v2.0 (Actuator-Native)
 * Autonomously bundles security, quality, and documentation drift checks.
 * Uses generic Actuators to replace deleted specialized skills.
 */

interface CheckResult {
  status: 'passed' | 'failed' | 'warning';
  output: string;
  evidence?: any;
}

async function runSecurityScan(): Promise<CheckResult> {
  logger.info('[Sentinel] Running Security Scan (Actuator-Native)...');
  
  const patterns = [
    'api[_-]?key|secret|password|token',
    'exec\\(.*[\\$|+]|spawn\\(.*[\\$|+]',
    'eval\\(|new Function\\('
  ];
  
  const results: any[] = [];
  
  for (const pattern of patterns) {
    try {
      const input = {
        action: 'search',
        path: '.',
        pattern: pattern
      };
      const inputPath = path.join(process.cwd(), `scratch/sentinel_sec_${Date.now()}.json`);
      safeWriteFile(inputPath, JSON.stringify(input));
      
      const output = safeExec('node', ['dist/libs/actuators/file-actuator/src/index.js', '--input', inputPath]);
      const parsed = JSON.parse(output);
      if (parsed.results && parsed.results.length > 0) {
        results.push(...parsed.results);
      }
      if (fs.existsSync(inputPath)) safeUnlinkSync(inputPath);
    } catch (e: any) {
      logger.error(`Security check failed for pattern ${pattern}: ${e.message}`);
    }
  }

  return {
    status: results.length > 0 ? 'warning' : 'passed',
    output: `Found ${results.length} potential security issues.`,
    evidence: results.slice(0, 10)
  };
}

async function runHealthCheck(): Promise<CheckResult> {
  logger.info('[Sentinel] Running Health Check (Static Analysis)...');
  try {
    safeExec('npm', ['run', 'lint']);
    safeExec('npm', ['run', 'typecheck']);
    return { 
      status: 'passed', 
      output: 'Static analysis and type checking passed.',
      evidence: { lint: 'OK', types: 'OK' } 
    };
  } catch (e: any) {
    return { 
      status: 'failed', 
      output: `Health check failed: ${e.message}`,
      evidence: e.stderr 
    };
  }
}

async function runSentinel(): Promise<void> {
  console.log('--- 🛡️ Sentinel Analysis Starting (v2.0) ---');

  const results: Record<string, CheckResult> = {};

  results['Security'] = await runSecurityScan();
  results['Health'] = await runHealthCheck();
  
  try {
    const todoOut = safeExec('rg', ['-rE', 'TODO|FIXME', '.', '--exclude-dir', 'node_modules', '--exclude-dir', '.git', '--max-count', '5']);
    results['Stale TODOs'] = { status: 'warning', output: todoOut || 'No TODOs found.' };
  } catch (_) {
    results['Stale TODOs'] = { status: 'passed', output: 'No TODOs found.' };
  }

  const outPath = 'active/shared/sentinel-report.json';
  safeWriteFile(pathResolver.resolve(outPath), JSON.stringify(results, null, 2));
  
  console.log('\n--- Sentinel Summary ---');
  Object.entries(results).forEach(([name, res]) => {
    const icon = res.status === 'passed' ? '✅' : res.status === 'failed' ? '❌' : '⚠️';
    console.log(`${icon} ${name.padEnd(15)} : ${res.status.toUpperCase()} - ${res.output}`);
  });
  
  console.log(`\nReport saved to ${outPath}`);
}

runSentinel().catch(err => {
  console.error(err);
  process.exit(1);
});
