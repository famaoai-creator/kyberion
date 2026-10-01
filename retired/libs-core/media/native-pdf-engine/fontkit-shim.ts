import { createFontkitRequire } from './fontkit-require.js';

// Same dual-path resolve as primitives.ts (source/@agent/core dist + bundled CLI).
const fontkit = createFontkitRequire()('fontkit');

export default fontkit;
