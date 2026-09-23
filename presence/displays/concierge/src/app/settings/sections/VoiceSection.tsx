'use client';

import * as React from 'react';
import {
  AvatarPicker,
  Button,
  FileDrop,
  Select,
  SettingRow,
  SettingsGroup,
  StatusPill,
  TextField,
} from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type { Setup, VoiceSelection } from '../../../lib/settings-types';
import type { VoiceInputDevice } from '../../../lib/voice-types';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** FD-06 写真・音声 pane (`#setup-media`) — avatar + voice sample
 * recording + voice runtime. Extracted from settings/page.tsx; the recorder
 * refs and every handler (startVoiceRecording, upload, …) stay owned by the
 * page. UI-06: the avatar uses the shared `AvatarPicker` (upload + camera
 * capture with square-crop preview; the camera stream is started only by
 * the person and stopped on confirm / cancel / unmount) and the voice
 * sample upload uses `FileDrop`; both hand the File to the page's existing
 * `POST /api/setup` multipart upload. */
export type VoiceProfileState = { profile_id: string; display_name: string };

export const VOICE_SAMPLE_ACCEPT = 'audio/webm,audio/wav,audio/ogg,audio/mp4';

export type VoiceSectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  setup: Setup;
  busy: boolean;
  /** AvatarPicker confirm goes to the page's avatar upload (`source` = upload | camera). */
  onAvatarChange: (file: Blob, source: 'upload' | 'camera') => void;
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
  onAvatarChange,
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
  const sampleLimitReached = voiceSampleRefs.length >= 3;
  return (
    <div
      className="settings-section"
      id="setup-media"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_voice', locale)}
    >
      <FormScope
        fields={{
          'voice.profile_id': (value) => setVoice({ ...voice, profile_id: asText(value) }),
          'voice.display_name': (value) => setVoice({ ...voice, display_name: asText(value) }),
          'voice.stt_backend': (value) => onSaveVoiceSelection('stt_backend', asText(value)),
          'voice.tts_engine_id': (value) => onSaveVoiceSelection('tts_engine_id', asText(value)),
        }}
        actions={{
          'avatar.change': (payload) => {
            const file = payload.file;
            if (file instanceof Blob) {
              onAvatarChange(file, payload.source === 'camera' ? 'camera' : 'upload');
            }
          },
          'voice.sample.add': (payload) => {
            const files = Array.isArray(payload.files) ? payload.files : [];
            const first = files[0];
            if (first instanceof File) onVoiceSampleFileChange(first);
          },
        }}
      >
        <SettingsGroup
          id="settings-avatar"
          title={frontDeskText('settings_nav_voice', locale)}
          description={t('setup.media_description')}
        >
          <SettingRow label={t('setup.photo_avatar')} description={t('setup.avatar_flow')}>
            <StatusPill
              status={setup.profile.avatar_registered ? 'completed' : 'needs_setup'}
              label={
                setup.profile.avatar_registered ? t('setup.registered') : t('setup.unregistered')
              }
            />
          </SettingRow>
          <div className="settings-row-block">
            <AvatarPicker
              id="avatar"
              name="avatar"
              label={t('setup.image_label')}
              hide_label
              help={t('setup.camera_fallback')}
              initials={(setup.profile.name || '').trim().slice(0, 1).toUpperCase() || undefined}
              allow_camera
              disabled={busy}
            />
          </div>
        </SettingsGroup>

        <SettingsGroup
          id="settings-voice-profile"
          title={t('setup.voice_profile')}
          description={t('setup.voice_sample_count', { count: voiceSampleRefs.length })}
        >
          <SettingRow label={t('setup.voice_id_label')}>
            <TextField
              id="voice-profile-id"
              name="voice.profile_id"
              label={t('setup.voice_id_label')}
              hide_label
              value={voice.profile_id}
              placeholder="my-voice"
            />
          </SettingRow>
          <SettingRow label={t('setup.voice_name_label')}>
            <TextField
              id="voice-display-name"
              name="voice.display_name"
              label={t('setup.voice_name_label')}
              hide_label
              value={voice.display_name}
              placeholder="My voice"
            />
          </SettingRow>
          <SettingRow label={t('setup.record_voice')} description={t('setup.consent')}>
            {voiceRecording ? (
              <Button
                label={t('setup.stop_recording')}
                variant="primary"
                disabled={busy}
                onClick={onStopVoiceRecording}
              />
            ) : (
              <Button
                label={t('setup.record_voice')}
                variant="secondary"
                disabled={busy || sampleLimitReached}
                onClick={onStartVoiceRecording}
              />
            )}
          </SettingRow>
          <div className="settings-row-block">
            <FileDrop
              id="voice-sample"
              name="voice.sample"
              label={t('setup.voice_sample_label')}
              accept={VOICE_SAMPLE_ACCEPT}
              disabled={busy || sampleLimitReached}
              action={{ id: 'voice.sample.add' }}
            />
          </div>
          <div className="settings-row-actions">
            <Button
              label={t('setup.save_voice')}
              variant="primary"
              disabled={busy || !voiceSampleRefs.length}
              onClick={onSaveVoice}
            />
          </div>
        </SettingsGroup>

        <div className="settings-subsection" id="voice-runtime-settings">
          <SettingsGroup
            id="settings-voice-runtime"
            title={frontDeskText('settings_voice_runtime_title', locale)}
            description={frontDeskText('settings_voice_runtime_lead', locale)}
          >
            {voiceSelection ? (
              <>
                <SettingRow label={t('dock.voice.backend')}>
                  <Select
                    id="voice-stt-backend"
                    name="voice.stt_backend"
                    label={t('dock.voice.backend')}
                    hide_label
                    value={voiceSelection.preferences.stt_backend}
                    disabled={voiceSelectionBusy}
                    options={[
                      { value: 'auto', label: t('dock.voice.auto') },
                      ...voiceSelection.stt.candidates.map((candidate) => ({
                        value: candidate.backend,
                        label: candidate.display_name,
                        disabled: !candidate.selectable,
                      })),
                    ]}
                  />
                </SettingRow>
                <SettingRow
                  label={t('setup.voice_profile')}
                  description={voiceDevices.length > 0 ? voiceDevices[0].name : undefined}
                >
                  <Select
                    id="voice-tts-engine"
                    name="voice.tts_engine_id"
                    label={t('setup.voice_profile')}
                    hide_label
                    value={voiceSelection.preferences.tts_engine_id}
                    disabled={voiceSelectionBusy}
                    options={voiceSelection.tts.candidates.map((candidate) => ({
                      value: candidate.engine_id,
                      label: candidate.display_name,
                      disabled: !candidate.selectable,
                    }))}
                  />
                </SettingRow>
              </>
            ) : (
              <div className="settings-row-block">
                <p className="kb-text kb-text--muted">{t('setup.loading')}</p>
              </div>
            )}
          </SettingsGroup>
        </div>
      </FormScope>
    </div>
  );
}
