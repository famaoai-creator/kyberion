import { randomUUID } from 'node:crypto';

async function main() {
  const response = await fetch('http://127.0.0.1:3032/api/ingest-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: randomUUID(),
      text: 'This line came through the managed voice hub.',
      intent: 'conversation',
      speaker: 'User',
      reflect_to_surface: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Voice hub ingest failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
