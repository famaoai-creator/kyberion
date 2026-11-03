/**
 * C7 shared daemon/bridge poll-loop helper (`bridge:poll_loop`) — moved to
 * `@agent/core/bridge-poll-loop` so every consumer (bridges, presence-studio,
 * Concierge SSE routes) shares one module instance and one registry. This
 * file keeps the bridges' existing relative import working.
 */
export * from '@agent/core/bridge-poll-loop';
