/**
 * Compatibility re-export. The implementation moved to
 * `libs/core/media/video-generation/provider.ts` so video generation shares
 * the `libs/core/media/<domain>/` layout used by image and music generation;
 * keep importing through this path inside the actuator.
 */
export * from '@agent/core/media/video-generation/provider';
