import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

/**
 * Worker Proxy for Kyberion.
 * Offloads CPU-intensive tasks to background threads.
 */

export function runInWorker(scriptPath: string, data: any): Promise<any> {
  if (isMainThread) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { scriptPath, data },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  } else {
    // This part runs in the worker
    (async () => {
      const { scriptPath, data } = workerData;
      try {
        const module = await import(scriptPath);
        const task = module.default || module;
        const result = typeof task === 'function' ? task(data) : task;
        parentPort?.postMessage(result);
      } catch (err) {
        throw err;
      }
    })();
    return Promise.resolve(); // Keep TS happy
  }
}

export const workerProxyPath = fileURLToPath(import.meta.url);

if (!isMainThread) {
  (async () => {
    const { scriptPath, data } = workerData;
    try {
      const module = await import(scriptPath);
      const task = module.default || module;
      const result = typeof task === 'function' ? task(data) : task;
      parentPort?.postMessage(result);
    } catch (err) {
      throw err;
    }
  })();
}
