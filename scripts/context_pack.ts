#!/usr/bin/env node
import { defineScript, isDirectScript, type ScriptContext } from './lib/harness.js';
import { formatCliUsage, hasHelpFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveScopeContext } from '@agent/core/scope-context';
import { listEnvironmentManifestIds } from '@agent/core/environment-capability';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

export const CONTEXT_PACK_CLI: CliGuardSpec = {
  command: 'pnpm kyberion context pack',
  manifestId: 'script.context.pack',
  options: [
    { flag: '--task', value: '<type>' },
    { flag: '--tenant', value: '<slug>' },
    { flag: '--tier', value: '<personal|confidential|public>' },
    { flag: '--json' },
  ],
};

export const runContextPack = defineScript({
  name: 'context-pack',
  async run(context: ScriptContext) {
    if (hasHelpFlag(context.argv)) {
      context.print(formatCliUsage(CONTEXT_PACK_CLI));
      return undefined;
    }

    const argv = await createStandardYargs(['node', 'context_pack', ...context.argv])
      .option('task', { type: 'string', default: 'general' })
      .option('tenant', { type: 'string' })
      .option('tier', { type: 'string' })
      .parseSync();

    const scope = resolveScopeContext();
    const taskType = String(argv.task || 'general');
    const isJson = Boolean(context.json || argv.json);

    // Collect available manifests
    const manifests = listEnvironmentManifestIds();

    // Read high-level operating guide summary
    const guidePath = pathResolver.rootResolve('GEMINI.md');
    const guideSnippet = safeExistsSync(guidePath)
      ? safeReadFile(guidePath).slice(0, 800) + '...\n(see GEMINI.md for full operating rules)'
      : 'Operating guide not found';

    const pack = {
      task: taskType,
      scope: {
        tier: argv.tier || scope.tier,
        tenant: argv.tenant || scope.tenant_slug || 'default',
        stance: scope.customer_stance || 'none',
      },
      available_manifests: manifests,
      operating_invariants: [
        'File I/O: only via @agent/core/secure-io. Never call node:fs directly.',
        'Missions: start / checkpoint / finish only via scripts/mission_controller.ts.',
        'Data tiers: knowledge/personal/ -> confidential/ -> public/. Never leak from higher to lower.',
        'Perceive through the actuator: pnpm kyberion read/see/listen/watch/speak/draw.',
        'Apply the working philosophy: read before write; one change, one verification.',
      ],
      guide_summary: guideSnippet,
    };

    if (isJson) {
      context.print(pack);
    } else {
      const md = [
        `# Kyberion Fast-Context Pack [Task: ${pack.task}]`,
        '',
        `## 1. Active Scope`,
        `- Tier: \`${pack.scope.tier}\``,
        `- Tenant: \`${pack.scope.tenant}\``,
        `- Stance: \`${pack.scope.stance}\``,
        '',
        `## 2. Invariants & Guardrails`,
        ...pack.operating_invariants.map((inv) => `- ${inv}`),
        '',
        `## 3. Available Capabilities & Manifests`,
        pack.available_manifests.map((m) => `\`${m}\``).join(', '),
        '',
        `## 4. Operating Rules Summary`,
        '```markdown',
        pack.guide_summary,
        '```',
      ].join('\n');
      context.print(md);
    }

    return pack;
  },
});

if (
  isDirectScript(import.meta.url, 'context_pack.ts') ||
  isDirectScript(import.meta.url, 'context_pack.js')
) {
  void runContextPack();
}
