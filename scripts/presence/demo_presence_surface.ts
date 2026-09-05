import { dispatchA2UI } from '@agent/core/a2ui';
import { buildPresenceSurfaceFrame } from '@agent/core/presence-surface';
import { defineScript, isDirectScript } from '../lib/harness.js';

type Print = (value: unknown) => void;

async function main(print: Print = () => undefined) {
  const messages = buildPresenceSurfaceFrame({
    agentId: 'presence-surface-agent',
    title: 'Presence Studio',
    status: 'speaking',
    expression: 'joy',
    subtitle: 'Kyberion presence surface MVP is live.',
    transcript: [
      { speaker: 'User', text: 'Can you become a realtime expressive agent?' },
      { speaker: 'Kyberion', text: 'Yes. This MVP uses existing channel and surface concepts.' },
    ],
  });

  for (const message of messages) {
    dispatchA2UI(message);
  }

  // Allow the bridge transport fetch to flush before this short-lived process exits.
  await new Promise((resolve) => setTimeout(resolve, 400));
  print('Presence surface demo dispatched.');
}

const runPresenceSurfaceDemo = defineScript({
  name: 'presence-demo-surface',
  flags: [],
  run: ({ print }) => main(print),
});

if (
  isDirectScript(import.meta.url, 'presence/demo_presence_surface.ts') ||
  isDirectScript(import.meta.url, 'presence/demo_presence_surface.js')
)
  void runPresenceSurfaceDemo();
