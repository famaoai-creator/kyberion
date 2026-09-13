'use client';

import * as React from 'react';
import { parseVoiceSelectionResponse, type Notice, type VoiceSelection } from './settings-types';
import { parseVoiceInputDevices, type VoiceInputDevice } from './voice-types';

/**
 * 声と話し方 runtime settings — TTS engine / STT backend / input device.
 * Split out of settings/page.tsx into its own hook (same posture as
 * use-voice.ts) so the page stays under the KP max-file-lines gate. Voice is
 * optional infrastructure: every failure degrades silently, same as every
 * other settings pane backed by an external daemon.
 */
export interface UseVoiceSelectionResult {
  voiceSelection: VoiceSelection | null;
  voiceDevices: VoiceInputDevice[];
  voiceSelectionBusy: boolean;
  refreshVoiceSelection: () => Promise<void>;
  saveVoiceSelection: (field: 'tts_engine_id' | 'stt_backend', value: string) => Promise<void>;
}

export function useVoiceSelection(setNotice: (notice: Notice) => void): UseVoiceSelectionResult {
  const [voiceSelection, setVoiceSelection] = React.useState<VoiceSelection | null>(null);
  const [voiceDevices, setVoiceDevices] = React.useState<VoiceInputDevice[]>([]);
  const [voiceSelectionBusy, setVoiceSelectionBusy] = React.useState(false);

  const refreshVoiceSelection = React.useCallback(async () => {
    try {
      const [selectionResponse, statusResponse] = await Promise.all([
        fetch('/api/voice/selection', { cache: 'no-store' }),
        fetch('/api/voice/status', { cache: 'no-store' }),
      ]);
      const selection = parseVoiceSelectionResponse(
        await selectionResponse.json().catch(() => null)
      );
      if (selectionResponse.ok && selection) setVoiceSelection(selection);
      const status = (await statusResponse.json().catch(() => null)) as {
        inputDevices?: unknown;
      } | null;
      const devices = parseVoiceInputDevices(status?.inputDevices);
      if (statusResponse.ok && devices) setVoiceDevices(devices);
    } catch {
      // Voice is optional; the settings page remains usable when voice-hub is down.
    }
  }, []);

  const saveVoiceSelection = React.useCallback(
    async (field: 'tts_engine_id' | 'stt_backend', value: string) => {
      if (!voiceSelection) return;
      setVoiceSelectionBusy(true);
      try {
        const response = await fetch('/api/voice/selection', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...voiceSelection.preferences, [field]: value }),
        });
        const next = parseVoiceSelectionResponse(await response.json().catch(() => null));
        if (!response.ok || !next) throw new Error('Voice selection could not be saved');
        setVoiceSelection(next);
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setVoiceSelectionBusy(false);
      }
    },
    [voiceSelection, setNotice]
  );

  return {
    voiceSelection,
    voiceDevices,
    voiceSelectionBusy,
    refreshVoiceSelection,
    saveVoiceSelection,
  };
}
