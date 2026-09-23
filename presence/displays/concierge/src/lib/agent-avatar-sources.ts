/**
 * PA-09: the default secretary avatar for the conversation dock when the
 * owner has not adopted a personal set — the product Kyberion SVGs
 * (knowledge/product/presence/avatar-profiles.json, served by presence-studio
 * under /assets/avatars/). Public-tier artwork, fixed expression allow-list
 * (never a path), any resolved viewer.
 */
export const AGENT_AVATAR_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  neutral: 'presence/displays/presence-studio/static/assets/avatars/kyberion-neutral.svg',
  joy: 'presence/displays/presence-studio/static/assets/avatars/kyberion-joy.svg',
  thinking: 'presence/displays/presence-studio/static/assets/avatars/kyberion-thinking.svg',
  listening: 'presence/displays/presence-studio/static/assets/avatars/kyberion-listening.svg',
  blink: 'presence/displays/presence-studio/static/assets/avatars/kyberion-blink.svg',
});
