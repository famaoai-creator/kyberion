/**
 * Capture/record verb dispatch for the operator CLI (`scripts/cli.ts`).
 *
 * `capture` (still image) and `record screen|audio|camera` (time-series) are
 * thin verbs over the system-actuator's canonical capture ops. They live here
 * instead of inline in `cli.ts` so the dispatcher stays under the file-length
 * gate; the manifest registration (`operator-cli.capture`, `record screen`,
 * `record audio`, `record camera`) stays in
 * `knowledge/product/governance/cli-commands.json`.
 */
import { setRegisteredEnv } from '@agent/core/foundation';

export interface CaptureDispatchInput {
  command: string;
  firstArg: string | undefined;
  restArgs: string[];
  normalizedArgs: string[];
  print: (text: string) => void;
}

/** Runs the capture/record verb when matched; returns false when untouched. */
export async function dispatchCaptureCommand(input: CaptureDispatchInput): Promise<boolean> {
  const { command, firstArg, restArgs, normalizedArgs, print } = input;
  const quietUnlessVerbose = (): void => {
    if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
  };
  if (command === 'capture') {
    // Still-image capture (thin over system:screenshot / system:capture_photo).
    // Stdout carries the summary (or --json).
    quietUnlessVerbose();
    const { runCaptureCommand } = await import('../cli-capture.js');
    await runCaptureCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], print);
    return true;
  }
  if (
    command === 'record' &&
    (firstArg === 'screen' || firstArg === 'audio' || firstArg === 'camera')
  ) {
    // Time-series recording (thin over system:record_screen / record_audio /
    // record_camera). Two-word commands so the bare `record` (operator-home
    // desktop demonstration recorder) keeps working.
    quietUnlessVerbose();
    const { runRecordCommand } = await import('../cli-record.js');
    await runRecordCommand([`--${firstArg}`, ...restArgs], print);
    return true;
  }
  return false;
}
