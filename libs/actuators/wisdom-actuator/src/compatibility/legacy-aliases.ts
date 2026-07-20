/**
 * Wisdom operation aliases retained for one migration window.
 *
 * This module deliberately contains naming compatibility only. It must not
 * implement the aliased operation or import another actuator package.
 */
export const DEPRECATED_WISDOM_ALIASES = {
  a2a_fanout: 'perspective_fanout',
  a2a_roleplay: 'counterparty_roleplay',
  cross_critique: 'typed_cross_critique',
  tool_use: 'propose_tool_calls',
  react_loop: 'reasoning_loop',
} as const;

export type DeprecatedWisdomAlias = keyof typeof DEPRECATED_WISDOM_ALIASES;

export function canonicalWisdomOp(op: string): string {
  return DEPRECATED_WISDOM_ALIASES[op as DeprecatedWisdomAlias] || op;
}
