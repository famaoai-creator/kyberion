/**
 * Worker-thread entry. Heavy synchronous governed loaders run here so the Ink
 * render thread only renders and handles keys.
 */
import { parentPort } from 'node:worker_threads';
import { DeckEngine } from './engine.js';
import type { FromWorker, ToWorker } from './protocol.js';

const port = parentPort;

if (port) {
  const post = (message: FromWorker) => port.postMessage(message);
  const engine = new DeckEngine((snapshot) => post({ type: 'snapshot', snapshot }));
  let started = false;

  port.on('message', (message: ToWorker) => {
    switch (message.type) {
      case 'config':
        engine.configure({
          locale: message.locale,
          intervalMs: message.intervalMs,
          includeAgents: message.includeAgents,
        });
        if (!started) {
          started = true;
          try {
            engine.start();
          } catch (err) {
            post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      case 'refresh':
        engine.refresh();
        return;
      case 'stop':
        engine.stop();
        port.close();
        return;
      case 'request':
        void engine
          .handle(message.request)
          .then((value) => post({ type: 'response', id: message.id, ok: true, value }))
          .catch((err: unknown) =>
            post({
              type: 'response',
              id: message.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        return;
    }
  });
}
