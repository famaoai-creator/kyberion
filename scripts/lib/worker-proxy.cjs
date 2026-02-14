const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

/**
 * Worker Proxy for Gemini Skills.
 * Offloads CPU-intensive tasks to background threads.
 */

if (isMainThread) {
  module.exports = function runInWorker(scriptPath, data) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { scriptPath, data },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  };
} else {
  // Worker side
  const { scriptPath, data } = workerData;
  try {
    const task = require(scriptPath);
    const result = typeof task === 'function' ? task(data) : task;
    parentPort.postMessage(result);
  } catch (err) {
    throw err;
  }
}
