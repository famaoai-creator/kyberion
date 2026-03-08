"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.walk = walk;
exports.getAllFiles = getAllFiles;
exports.walkAsync = walkAsync;
exports.getAllFilesAsync = getAllFilesAsync;
exports.mapAsync = mapAsync;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_loader_js_1 = require("./config-loader.js");
const standards = (0, config_loader_js_1.loadProjectStandards)();
/**
 * Recursively walk through a directory and yield file paths.
 */
function* walk(dir, options = {}) {
    const { maxDepth = Infinity, currentDepth = 0 } = options;
    if (currentDepth > maxDepth)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (_e) {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (standards.ignore_dirs.includes(entry.name))
                continue;
            yield* walk(fullPath, { ...options, currentDepth: currentDepth + 1 });
        }
        else {
            const ext = path.extname(entry.name).toLowerCase();
            if (standards.ignore_extensions.includes(ext))
                continue;
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
 */
async function* walkAsync(dir, options = {}) {
    const { maxDepth = Infinity, currentDepth = 0 } = options;
    if (currentDepth > maxDepth)
        return;
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch (_e) {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (standards.ignore_dirs.includes(entry.name))
                continue;
            yield* walkAsync(fullPath, { ...options, currentDepth: currentDepth + 1 });
        }
        else {
            const ext = path.extname(entry.name).toLowerCase();
            if (standards.ignore_extensions.includes(ext))
                continue;
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
 */
async function mapAsync(items, concurrency, taskFn) {
    const results = [];
    const queue = [...items];
    const total = items.length;
    const runners = Array(Math.min(concurrency, items.length))
        .fill(null)
        .map(async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            const index = total - queue.length - 1;
            results[index] = await taskFn(item);
        }
    });
    await Promise.all(runners);
    return results;
}
