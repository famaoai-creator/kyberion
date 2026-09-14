'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { Setup, VoiceSelection } from '../../../lib/settings-types';
import type { VoiceInputDevice } from '../../../lib/voice-types';

/** FD-06 写真・音声 pane (`#setup-media`) — camera capture + voice sample
 * recording. Extracted from settings/page.tsx; the camera/recorder refs and
 * every handler (startCamera, captureAvatar, startVoiceRecording, upload,
 * …) stay owned by the page and are passed in as props/refs. */
export type VoiceProfileState = { profile_id: string; display_name: string };

export type VoiceSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
  setup: Setup;
  busy: boolean;
  cameraState: 'idle' | 'starting' | 'ready';
  cameraVideoRef: React.RefObject<HTMLVideoElement | null>;
  cameraCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onCaptureAvatar: () => void;
  onAvatarFileChange: (file: File) => void;
  voice: VoiceProfileState;
  setVoice: (voice: VoiceProfileState) => void;
  voiceSampleRefs: string[];
  voiceRecording: boolean;
  onStartVoiceRecording: () => void;
  onStopVoiceRecording: () => void;
  onVoiceSampleFileChange: (file: File) => void;
  onSaveVoice: () => void;
  /** 声と話し方: TTS engine / STT backend / input device (HT plan §2.3). Null
   * while /api/voice/selection is still loading or voice-hub is down. */
  voiceSelection: VoiceSelection | null;
  voiceDevices: VoiceInputDevice[];
  voiceSelectionBusy: boolean;
  onSaveVoiceSelection: (field: 'tts_engine_id' | 'stt_backend', value: string) => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function VoiceSection({
  locale,
  t,
  setup,
  busy,
  cameraState,
  cameraVideoRef,
  cameraCanvasRef,
  onStartCamera,
  onStopCamera,
  onCaptureAvatar,
  onAvatarFileChange,
  voice,
  setVoice,
  voiceSampleRefs,
  voiceRecording,
  onStartVoiceRecording,
  onStopVoiceRecording,
  onVoiceSampleFileChange,
  onSaveVoice,
  voiceSelection,
  voiceDevices,
  voiceSelectionBusy,
  onSaveVoiceSelection,
  sectionRef,
}: VoiceSectionProps) {
  return (
    <section
      className="pane"
      id="setup-media"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_voice', locale)}
    >
      <h2>{frontDeskText('settings_nav_voice', locale)}</h2>
      <h3 className="pane-subheading">{t('setup.media_title')}</h3>
      <p className="pane-subtitle">{t('setup.media_description')}</p>
      <div className="item-card">
        <p className="item-title">
          {t('setup.photo_avatar')}{' '}
          <span className={`status-chip${setup.profile.avatar_registered ? '' : ' attention'}`}>
            {setup.profile.avatar_registered ? t('setup.registered') : t('setup.unregistered')}
          </span>
        </p>
        <p className="item-meta">{t('setup.avatar_flow')}</p>
        {cameraState !== 'idle' ? (
          <video
            ref={cameraVideoRef}
            className="media-preview"
            muted
            playsInline
            aria-label={t('setup.camera_preview')}
          />
        ) : null}
        <canvas ref={cameraCanvasRef} hidden />
        <div className="button-row">
          {cameraState === 'idle' ? (
            <button className="action-button secondary" disabled={busy} onClick={onStartCamera}>
              {t('setup.open_camera')}
            </button>
          ) : null}
          {cameraState === 'starting' ? (
            <button className="action-button secondary" disabled>
              {t('setup.camera_starting')}
            </button>
          ) : null}
          {cameraState === 'ready' ? (
            <>
              <button className="action-button" disabled={busy} onClick={onCaptureAvatar}>
                {t('setup.capture_avatar')}
              </button>
              <button className="action-button secondary" disabled={busy} onClick={onStopCamera}>
                {t('setup.close_camera')}
              </button>
            </>
          ) : null}
        </div>
        <p className="item-meta">{t('setup.camera_fallback')}</p>
        <input
          aria-label={t('setup.image_label')}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onAvatarFileChange(file);
          }}
        />
      </div>
      <div className="item-card">
        <p className="item-title">
          {t('setup.voice_profile')} <span className="status-chip">{t('setup.consent')}</span>
        </p>
        <div className="field-row">
          <input
            aria-label={t('setup.voice_id_label')}
            value={voice.profile_id}
            onChange={(event) => setVoice({ ...voice, profile_id: event.target.value })}
            placeholder="my-voice"
          />
          <input
            aria-label={t('setup.voice_name_label')}
            value={voice.display_name}
            onChange={(event) => setVoice({ ...voice, display_name: event.target.value })}
            placeholder="My voice"
          />
        </div>
        <p className="item-meta">
          {t('setup.voice_sample_count', { count: voiceSampleRefs.length })}
        </p>
        <div className="button-row">
          {voiceRecording ? (
            <button className="action-button" disabled={busy} onClick={onStopVoiceRecording}>
              {t('setup.stop_recording')}
            </button>
          ) : (
            <button
              className="action-button secondary"
              disabled={busy || voiceSampleRefs.length >= 3}
              onClick={onStartVoiceRecording}
            >
              {t('setup.record_voice')}
            </button>
          )}
        </div>
        <input
          aria-label={t('setup.voice_sample_label')}
          type="file"
          accept="audio/webm,audio/wav,audio/ogg,audio/mp4"
          disabled={busy || voiceSampleRefs.length >= 3}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onVoiceSampleFileChange(file);
          }}
        />
        <div className="button-row">
          <button
            className="action-button secondary"
            disabled={busy || !voiceSampleRefs.length}
            onClick={onSaveVoice}
          >
            {t('setup.save_voice')}
          </button>
        </div>
      </div>
      <div className="item-card" id="voice-runtime-settings">
        <p className="item-title">{frontDeskText('settings_voice_runtime_title', locale)}</p>
        <p className="item-meta">{frontDeskText('settings_voice_runtime_lead', locale)}</p>
        {voiceSelection ? (
          <div className="field-column">
            <label className="field-label">
              {t('dock.voice.backend')}
              <select
                value={voiceSelection.preferences.stt_backend}
                disabled={voiceSelectionBusy}
                onChange={(event) => onSaveVoiceSelection('stt_backend', event.target.value)}
              >
                <option value="auto">{t('dock.voice.auto')}</option>
                {voiceSelection.stt.candidates.map((candidate) => (
                  <option
                    key={candidate.backend}
                    value={candidate.backend}
                    disabled={!candidate.selectable}
                  >
                    {candidate.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              {t('setup.voice_profile')}
              <select
                value={voiceSelection.preferences.tts_engine_id}
                disabled={voiceSelectionBusy}
                onChange={(event) => onSaveVoiceSelection('tts_engine_id', event.target.value)}
              >
                {voiceSelection.tts.candidates.map((candidate) => (
                  <option
                    key={candidate.engine_id}
                    value={candidate.engine_id}
                    disabled={!candidate.selectable}
                  >
                    {candidate.display_name}
                  </option>
                ))}
              </select>
            </label>
            {voiceDevices.length > 0 ? <p className="item-meta">{voiceDevices[0].name}</p> : null}
          </div>
        ) : (
          <p className="item-meta">{t('setup.loading')}</p>
        )}
      </div>
    </section>
  );
}
