import { useCallback, useRef, useState } from 'react';
import { probeMicCapture } from '@agent/core/mic-capture';
import {
  beginVoiceCapture,
  transcribeWavBuffer,
  type VoiceCaptureHandle,
} from './voice-capture.js';
import type { VoiceState } from '../components/input-bar.js';

export interface VoiceToggleOutcome {
  text?: string;
  error?: string;
}

export interface VoiceInput {
  state: VoiceState;
  /** Push-to-talk toggle: first call starts recording, second call stops and transcribes. */
  toggle: () => Promise<VoiceToggleOutcome>;
}

export function useVoiceInput(): VoiceInput {
  const [state, setState] = useState<VoiceState>(undefined);
  const handleRef = useRef<VoiceCaptureHandle | null>(null);

  const toggle = useCallback(async (): Promise<VoiceToggleOutcome> => {
    if (state === 'transcribing') return {};
    if (!handleRef.current) {
      const probe = probeMicCapture();
      if (!probe.available) {
        return { error: probe.reason ?? probe.backend };
      }
      try {
        handleRef.current = await beginVoiceCapture();
        setState('recording');
        return {};
      } catch (err: unknown) {
        handleRef.current = null;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    setState('transcribing');
    const handle = handleRef.current;
    handleRef.current = null;
    try {
      const wav = await handle.stop();
      const result = await transcribeWavBuffer(wav);
      return { text: result.text };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      setState(undefined);
    }
  }, [state]);

  return { state, toggle };
}
