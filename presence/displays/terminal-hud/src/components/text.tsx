import { Children, type ReactNode } from 'react';
import { Text as InkText, type TextProps } from 'ink';
import { sanitizeTerminalText } from '../terminal-text.js';

function sanitizeNode(node: ReactNode): ReactNode {
  if (typeof node === 'string' || typeof node === 'number') {
    return sanitizeTerminalText(node);
  }
  if (Array.isArray(node)) {
    return Children.map(node, sanitizeNode);
  }
  return node;
}

/**
 * Drop-in replacement for ink's <Text> that scrubs control bytes and escape
 * sequences out of every rendered string. Panel data, log tails, transcripts,
 * exec output, and model replies all render through this component — leaving
 * them raw let embedded ESC/CSI bytes reach the tty verbatim, which has
 * crashed Terminal.app ("CFString cannot be created from a negative number
 * of bytes") and taken the session down with it.
 */
export function Text({ children, ...rest }: TextProps): ReactNode {
  return <InkText {...rest}>{sanitizeNode(children)}</InkText>;
}
