/** Domain barrel — public surface for libs/core/video */
export * from './narrated-video-brief-compiler.js';
export * from './narrated-video-preference-profile.js';
export * from './video-composition-contract.js';
export type { VideoPresentationMode } from './video-content-brief-contract.js';
export {
  isHookSemantic,
  isProcessLikeSemantic,
  isProofLikeSemantic,
  isCtaLikeSemantic,
  estimateReadingTimeSec,
} from './video-content-brief-contract.js';
export * from './video-design-system.js';
export * from './video-device-lease.js';
export * from './video-frame-archive.js';
export * from './video-frame-bus.js';
export * from './video-motion-direction.js';
export * from './video-route.js';
export * from './video-scene-composition.js';
export * from './video-visual-direction.js';
