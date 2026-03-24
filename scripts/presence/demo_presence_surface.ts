import { buildPresenceSurfaceFrame, dispatchA2UI } from '@agent/core';

async function main() {
  const messages = buildPresenceSurfaceFrame({
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
  console.log('Presence surface demo dispatched.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
