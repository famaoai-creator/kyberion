async function main() {
  const timeline = {
    action: 'presence_timeline',
    surface_id: 'presence-studio',
    title: 'Presence Studio',
    interrupt_policy: 'replace',
    events: [
      { at_ms: 0, op: 'set_status', params: { value: 'thinking' } },
      { at_ms: 0, op: 'set_expression', params: { value: 'neutral' } },
      { at_ms: 0, op: 'set_subtitle', params: { text: 'Preparing a response...' } },
      { at_ms: 900, op: 'set_status', params: { value: 'speaking' } },
      { at_ms: 900, op: 'set_expression', params: { value: 'joy' } },
      { at_ms: 900, op: 'set_subtitle', params: { text: 'Timeline playback is now active.' } },
      { at_ms: 900, op: 'append_transcript', params: { speaker: 'Kyberion', text: 'Timeline playback is now active.' } },
      { at_ms: 2200, op: 'clear_subtitle' },
      { at_ms: 2200, op: 'set_status', params: { value: 'ready' } }
    ],
  };

  const response = await fetch('http://127.0.0.1:3031/api/timeline/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(timeline),
  });

  if (!response.ok) {
    throw new Error(`Timeline dispatch failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
