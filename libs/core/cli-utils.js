"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStandardYargs = createStandardYargs;
const yargs_1 = __importDefault(require("yargs"));
const helpers_1 = require("yargs/helpers");
/**
 * Creates a pre-configured yargs instance with common options.
 */
function createStandardYargs(args = process.argv) {
    return (0, yargs_1.default)((0, helpers_1.hideBin)(args))
        .option('input', {
        alias: 'i',
        type: 'string',
        description: 'Input file or directory path',
    })
        .option('out', {
        alias: 'o',
        type: 'string',
        description: 'Output file path (optional)',
    })
        .option('tier', {
        type: 'string',
        choices: ['personal', 'confidential', 'public'],
        default: 'public',
        description: 'Knowledge tier for the operation',
    })
        .help('h')
        .alias('h', 'help');
}
//# sourceMappingURL=cli-utils.js.map