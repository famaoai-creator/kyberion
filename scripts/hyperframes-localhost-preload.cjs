'use strict';

const net = require('node:net');

const originalListen = net.Server.prototype.listen;

function isUnboundHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '::0' || host === undefined || host === null;
}

function normalizeListenArgs(args) {
  if (args.length === 0) return args;
  const next = Array.from(args);

  if (typeof next[0] === 'object' && next[0] !== null && !Array.isArray(next[0])) {
    const options = { ...next[0] };
    if (isUnboundHost(options.host) || isUnboundHost(options.hostname)) {
      options.host = '127.0.0.1';
      options.hostname = '127.0.0.1';
    }
    next[0] = options;
    return next;
  }

  if (next.length === 1 && (typeof next[0] === 'number' || typeof next[0] === 'string' || typeof next[0] === 'bigint')) {
    return [next[0], '127.0.0.1'];
  }

  if (typeof next[0] === 'number' || typeof next[0] === 'string' || typeof next[0] === 'bigint') {
    if (typeof next[1] === 'function') {
      return [next[0], '127.0.0.1', next[1]];
    }
    if (typeof next[1] === 'number') {
      if (typeof next[2] === 'function') {
        return [next[0], '127.0.0.1', next[1], next[2]];
      }
      return [next[0], '127.0.0.1', next[1]];
    }
    if (next.length >= 2 && (next[1] === undefined || next[1] === null)) {
      const remainder = next.slice(2);
      return [next[0], '127.0.0.1', ...remainder];
    }
  }

  for (let i = 0; i < next.length; i += 1) {
    if (typeof next[i] === 'string' && isUnboundHost(next[i])) {
      next[i] = '127.0.0.1';
    }
  }

  return next;
}

net.Server.prototype.listen = function patchedListen(...args) {
  return originalListen.apply(this, normalizeListenArgs(args));
};
