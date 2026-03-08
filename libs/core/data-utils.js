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
exports.detectFormat = detectFormat;
exports.parseData = parseData;
exports.stringifyData = stringifyData;
const yaml = __importStar(require("js-yaml"));
const Papa = __importStar(require("papaparse"));
const path = __importStar(require("node:path"));
function detectFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json')
        return 'json';
    if (ext === '.yaml' || ext === '.yml')
        return 'yaml';
    if (ext === '.csv')
        return 'csv';
    throw new Error(`Unsupported file extension: ${ext}`);
}
function parseData(content, format) {
    try {
        if (format === 'json')
            return JSON.parse(content);
        if (format === 'yaml')
            return yaml.load(content);
        if (format === 'csv') {
            const results = Papa.parse(content, { header: true, skipEmptyLines: true });
            return results.data;
        }
    }
    catch (err) {
        throw new Error(`Failed to parse ${format}: ${err.message}`);
    }
}
function stringifyData(data, format) {
    try {
        if (format === 'json')
            return JSON.stringify(data, null, 2);
        if (format === 'yaml')
            return yaml.dump(data);
        if (format === 'csv') {
            return Papa.unparse(data);
        }
    }
    catch (err) {
        throw new Error(`Failed to stringify ${format}: ${err.message}`);
    }
    return '';
}
