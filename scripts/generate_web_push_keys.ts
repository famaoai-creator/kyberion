import { generateWebPushKeys } from '@agent/core/surface/web-push';
import { defineScript, isDirectScript } from './lib/harness.js';

/**
 * Print a fresh VAPID key pair for Web Push. Nothing is written anywhere: put the
 * values in the deployment's secret store / environment yourself.
 *
 *   pnpm tsx scripts/generate_web_push_keys.ts
 */
export const runGenerateWebPushKeys = defineScript({
  name: 'generate-web-push-keys',
  flags: ['json'],
  run(context) {
    const keys = generateWebPushKeys();
    context.print(
      context.json
        ? JSON.stringify(keys, null, 2)
        : [
            `KYBERION_WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`,
            `KYBERION_WEB_PUSH_PRIVATE_KEY=${keys.privateKey}`,
            'KYBERION_WEB_PUSH_SUBJECT=mailto:you@example.com',
          ].join('\n')
    );
    return { generated: true };
  },
});

if (
  isDirectScript(import.meta.url, 'generate_web_push_keys.ts') ||
  isDirectScript(import.meta.url, 'generate_web_push_keys.js')
)
  void runGenerateWebPushKeys();
