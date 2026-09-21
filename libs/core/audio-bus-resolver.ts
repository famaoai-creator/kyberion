/**
 * Choose an AudioBus via the audio-bus-bridge seam.
 * Kept as the stable import path for existing callers.
 */

import './audio-bus-providers.js';
export { resolveAudioBus, type AudioBusId } from './audio-bus-bridge.js';
