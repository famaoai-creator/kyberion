'use client';

import * as React from 'react';
import { useChronosLocale } from '../../lib/ops/hooks';
import { uxText } from '../../lib/ops/ux-vocabulary';

/**
 * The exact CLI for an operator action, kept out of the way: a "コマンドを表示"
 * disclosure with a wrapping monospace block and a copy button. The human
 * action (a link or button) sits next to it; the command is for whoever wants
 * to run it by hand.
 */
export function CommandDisclosure({ command, label }: { command: string; label?: string }) {
  const locale = useChronosLocale();
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  // "Copied" goes back to "Copy" after a moment, so a second copy reads fresh.
  React.useEffect(() => {
    if (copy !== 'copied') return;
    const timer = setTimeout(() => setCopy('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copy]);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <details className="chronos-command">
      <summary>{label ?? uxText('ux_b_command_show', locale)}</summary>
      <div className="chronos-command__body">
        <pre className="chronos-command__code">
          <code>{command}</code>
        </pre>
        <div className="chronos-command__actions">
          <button type="button" className="kb-btn kb-btn--ghost" onClick={() => void onCopy()}>
            {uxText(copy === 'copied' ? 'ux_b_command_copied' : 'ux_b_command_copy', locale)}
          </button>
          <span role="status" className="chronos-command__note">
            {copy === 'failed'
              ? uxText('ux_b_command_copy_failed', locale)
              : copy === 'copied'
                ? uxText('ux_b_command_copied', locale)
                : ''}
          </span>
        </div>
      </div>
    </details>
  );
}
