"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInWorker = runInWorker;
const node_worker_threads_1 = require("node:worker_threads");
/**
 * Worker Proxy for Kyberion.
 * Offloads CPU-intensive tasks to background threads.
 */
function runInWorker(scriptPath, data) {
    if (node_worker_threads_1.isMainThread) {
        return new Promise((resolve, reject) => {
            const worker = new node_worker_threads_1.Worker(__filename, {
                workerData: { scriptPath, data },
            });
            worker.on('message', resolve);
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0)
                    reject(new Error(`Worker stopped with exit code ${code}`));
            });
        });
    }
    else {
        // This part runs in the worker
        (async () => {
            const { scriptPath, data } = node_worker_threads_1.workerData;
            try {
                const module = await import(scriptPath);
                const task = module.default || module;
                const result = typeof task === 'function' ? task(data) : task;
                node_worker_threads_1.parentPort?.postMessage(result);
            }
            catch (err) {
                throw err;
            }
        })();
        return Promise.resolve(); // Keep TS happy
    }
}
if (!node_worker_threads_1.isMainThread) {
    (async () => {
        const { scriptPath, data } = node_worker_threads_1.workerData;
        try {
            const module = await import(scriptPath);
            const task = module.default || module;
            const result = typeof task === 'function' ? task(data) : task;
            node_worker_threads_1.parentPort?.postMessage(result);
        }
        catch (err) {
            throw err;
        }
    })();
}
//# sourceMappingURL=worker-proxy.js.map