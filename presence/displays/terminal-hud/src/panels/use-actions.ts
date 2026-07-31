import { useCallback, useState } from 'react';
import type { ActionResult } from '../actions/dispatch.js';

export interface PendingConfirm {
  message: string;
  run: () => Promise<ActionResult> | ActionResult;
}

export interface PanelActions {
  confirm: PendingConfirm | null;
  status?: string;
  busy: boolean;
  request: (run: () => Promise<ActionResult> | ActionResult, confirmMessage?: string) => void;
  decide: (confirmed: boolean) => void;
}

export function usePanelActions(onDone?: () => void): PanelActions {
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const execute = useCallback(
    async (run: () => Promise<ActionResult> | ActionResult) => {
      setBusy(true);
      setStatus('…');
      try {
        const result = await run();
        setStatus(`${result.ok ? '✔' : '✖'} ${result.message}`);
      } catch (err: unknown) {
        setStatus(`✖ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
        onDone?.();
      }
    },
    [onDone]
  );

  const request = useCallback(
    (run: () => Promise<ActionResult> | ActionResult, confirmMessage?: string) => {
      if (confirmMessage) {
        setConfirm({ message: confirmMessage, run });
      } else {
        void execute(run);
      }
    },
    [execute]
  );

  const decide = useCallback(
    (confirmed: boolean) => {
      setConfirm((pending) => {
        if (confirmed && pending) void execute(pending.run);
        return null;
      });
    },
    [execute]
  );

  return { confirm, status, busy, request, decide };
}
