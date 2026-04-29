const net = require('node:net');

const originalListen = net.Server.prototype.listen;

function normalizeListenArgs(args) {
  if (args.length === 0) return args;

  if (typeof args[0] === 'object' && args[0] !== null) {
    const options = { ...args[0] };
    if (!options.host || options.host === '0.0.0.0') {
      options.host = '127.0.0.1';
    }
    if (!options.hostname || options.hostname === '0.0.0.0') {
      options.hostname = '127.0.0.1';
    }
    return [options, ...args.slice(1)];
  }

  if (typeof args[0] === 'number') {
    if (args.length === 1) return [args[0], '127.0.0.1'];
    if (typeof args[1] === 'function') return [args[0], '127.0.0.1', ...args.slice(1)];
    if (typeof args[1] === 'string' && args[1] === '0.0.0.0') {
      return [args[0], '127.0.0.1', ...args.slice(2)];
    }
  }

  return args;
}

net.Server.prototype.listen = function patchedListen(...args) {
  return originalListen.apply(this, normalizeListenArgs(args));
};
