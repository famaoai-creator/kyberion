import { createRequire } from 'node:module';
import { pathResolver } from '../../path-resolver.js';

// Same package-root resolve as primitives.ts — bundled CLI entrypoints do not
// sit next to fontkit the way the @agent/core source tree does.
const require = createRequire(pathResolver.rootResolve('libs/core/package.json'));
const fontkit = require('fontkit');

export default fontkit;
