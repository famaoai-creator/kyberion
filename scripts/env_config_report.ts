/**
 * OP-05 operational configuration report.
 *
 * The report is intentionally metadata-only: it shows names, counts, and
 * validation issues but never prints environment values. This makes it safe
 * to attach to a doctor result or scheduled maintenance packet.
 */

import {
  formatEnvValidationReport,
  loadEnvRegistryEntries,
  validateEnv,
} from '@agent/core/env-validator';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface EnvConfigReport {
  generated_at: string;
  registry: {
    registered: number;
    documented: number;
    undocumented: number;
  };
  runtime: {
    set_registered: number;
    unknown: string[];
    type_warnings: Array<{ name: string; issue: string }>;
    required_errors: Array<{ name: string; issue: string }>;
  };
}

export const ENV_CONFIG_REPORT_USAGE =
  'Usage: pnpm config:report [--json] [--fail-on-undocumented]';

export function buildEnvConfigReport(): EnvConfigReport {
  const entries = loadEnvRegistryEntries();
  const validation = validateEnv();
  return {
    generated_at: new Date().toISOString(),
    registry: {
      registered: entries.length,
      documented: entries.filter((entry) => entry.documented === true).length,
      undocumented: entries.filter((entry) => entry.documented !== true).length,
    },
    runtime: {
      set_registered: validation.checked,
      unknown: validation.unknown,
      type_warnings: validation.warnings,
      required_errors: validation.errors,
    },
  };
}

function parseArgs(argv: string[]): { json: boolean; failOnUndocumented: boolean } {
  return {
    json: argv.includes('--json'),
    failOnUndocumented: argv.includes('--fail-on-undocumented'),
  };
}

export function formatEnvConfigReport(report: EnvConfigReport): string {
  return [
    `Configuration registry: ${report.registry.documented}/${report.registry.registered} documented; ` +
      `${report.runtime.set_registered} registered variable(s) set`,
    ...formatEnvValidationReport({
      errors: report.runtime.required_errors,
      warnings: report.runtime.type_warnings,
      unknown: report.runtime.unknown,
      undocumented: [],
      checked: report.runtime.set_registered,
    }),
  ].join('\n');
}

export function main(argv: string[] = []): {
  report?: EnvConfigReport;
  status: number;
  help?: string;
} {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { status: 0, help: ENV_CONFIG_REPORT_USAGE };
  }

  const options = parseArgs(argv);
  const report = buildEnvConfigReport();
  return {
    report,
    status: options.failOnUndocumented && report.registry.undocumented > 0 ? 1 : 0,
  };
}

if (
  isDirectScript(import.meta.url, 'env_config_report.ts') ||
  isDirectScript(import.meta.url, 'env_config_report.js')
)
  void defineScript({
    name: 'config:report',
    flags: ['json'],
    run(context) {
      const result = main(context.argv);
      if (result.help) context.print(context.json ? result : result.help);
      else if (result.report)
        context.print(context.json ? result.report : formatEnvConfigReport(result.report));
      if (result.status !== 0) throw new ScriptExitError(result.status, '', true, result);
    },
  })();
