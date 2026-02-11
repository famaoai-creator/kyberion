const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

/**
 * Creates a pre-configured yargs instance with common options.
 * 
 * @param {Array} args - Process arguments (default: process.argv)
 * @returns {yargs.Argv}
 */
function createStandardYargs(args = process.argv) {
  return yargs(hideBin(args))
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input file or directory path'
    })
    .option('out', {
      alias: 'o',
      type: 'string',
      description: 'Output file path (optional)'
    })
    .option('tier', {
      alias: 't',
      type: 'string',
      choices: ['personal', 'confidential', 'public'],
      default: 'public',
      description: 'Knowledge tier for the operation'
    })
    .help('h')
    .alias('h', 'help');
}

module.exports = {
  createStandardYargs
};
