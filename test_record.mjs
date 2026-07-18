import { recordChronosSurfaceRequest } from './dist/libs/core/channel-surface.js';

async function main() {
  process.env.MISSION_ROLE = 'chronos_operator';
  console.log('Recording request...');
  try {
    const path = recordChronosSurfaceRequest({
      query: 'test',
      sessionId: 'test-session',
      requesterId: 'test',
    });
    console.log('Recorded to', path);
  } catch (e) {
    console.error('Error:', e.message);
  }
}
main();
