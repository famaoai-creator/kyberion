const fs = require('fs');
const path = require('path');
const { loadProjectStandards } = require('./config-loader.cjs');

const standards = loadProjectStandards();

/**
 * Recursively walk through a directory and yield file paths.
 * Automatically respects ignore lists from project_standards.json.
 * 
 * @param {string} dir - Directory to scan
 * @param {Object} options - Scan options (maxDepth, includeBinary, etc.)
 */
function* walk(dir, options = {}) {
    const { maxDepth = Infinity, currentDepth = 0 } = options;
    if (currentDepth > maxDepth) return;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
        return; // Skip inaccessible directories
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Check ignore lists
        if (entry.isDirectory()) {
            if (standards.ignore_dirs.includes(entry.name)) continue;
            yield* walk(fullPath, { ...options, currentDepth: currentDepth + 1 });
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (standards.ignore_extensions.includes(ext)) continue;
            yield fullPath;
        }
    }
}

/**
 * Get all files in a directory as an array.
 */
function getAllFiles(dir, options = {}) {
    return Array.from(walk(dir, options));
}

/**
 * Asynchronously walk through a directory and yield file paths.
 * 
 * @param {string} dir - Directory to scan
 * @param {Object} options - Scan options
 */
async function* walkAsync(dir, options = {}) {
    const { maxDepth = Infinity, currentDepth = 0 } = options;
    if (currentDepth > maxDepth) return;

    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_e) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (standards.ignore_dirs.includes(entry.name)) continue;
            yield* walkAsync(fullPath, { ...options, currentDepth: currentDepth + 1 });
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (standards.ignore_extensions.includes(ext)) continue;
            yield fullPath;
        }
    }
}

/**
 * Get all files asynchronously.
 */
async function getAllFilesAsync(dir, options = {}) {
    const files = [];
    for await (const file of walkAsync(dir, options)) {
        files.push(file);
    }
    return files;
}

/**
 * Map an array through an async function with limited concurrency.
 * @param {Array<T>} items - Items to process
 * @param {number} concurrency - Max simultaneous tasks
 * @param {function(T): Promise<R>} taskFn - Async function to apply
 * @returns {Promise<Array<R>>}
 */
async function mapAsync(items, concurrency, taskFn) {
    const results = [];
    const queue = [...items];
    const runners = Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
        while (queue.length > 0) {
            const index = items.length - queue.length;
            const item = queue.shift();
            results[index] = await taskFn(item);
        }
    });
    await Promise.all(runners);
    return results;
}

module.exports = {
    walk,
    getAllFiles,
    walkAsync,
    getAllFilesAsync,
    mapAsync
};
