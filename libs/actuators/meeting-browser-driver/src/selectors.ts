/**
 * Selectors for the meeting platforms' pre-join UIs. Kept in their
 * own file so a deployment can override them without touching the
 * driver runtime — vendors update their DOM occasionally and this is
 * the brittlest layer.
 *
 * Each entry names a CSS / role selector. The driver tries the list
 * in order until one resolves; the first hit wins. This makes it
 * easy to add fallback selectors as platforms re-skin.
 */

import type { MeetingPlatform } from '@agent/core';

export interface MeetingPreJoinSelectors {
  /** Optional input where the AI's display name goes (Meet for guests). */
  name_input: string[];
  /** Teams / vendor entry form field for a meeting ID or code. */
  meeting_id_input: string[];
  /** Teams / vendor entry form field for a passcode. */
  meeting_passcode_input: string[];
  /** Meet's pre-join continuation affordance before the actual join CTA appears. */
  continue_without_audio_video_button: string[];
  /** Open the Meet settings dialog before joining. */
  settings_button: string[];
  /** Device controls inside the Meet settings dialog. */
  microphone_device_button: string[];
  speaker_device_button: string[];
  camera_device_button: string[];
  /** Menu item / row for a device choice. */
  device_option: string[];
  /** Toggle to mute the bot's mic before joining (we control speaking via TTS). */
  mute_mic_button: string[];
  /** Toggle to disable the camera (we don't render video). */
  disable_camera_button: string[];
  /** "Join" / "Ask to join" / "Join now" button — the primary CTA. */
  join_button: string[];
  /** "Leave call" or hang-up affordance for clean disconnect. */
  leave_button: string[];
}

export const MEET_SELECTORS: MeetingPreJoinSelectors = {
  name_input: [
    // jsname is stable across locales — use as primary
    'input[jsname="YPqjbf"]',
    'input[aria-label="Your name"]',
    'input[placeholder="Your name"]',
    'input[aria-label="お名前を入力"]',
    'input[placeholder="お名前を入力"]',
  ],
  meeting_id_input: [],
  meeting_passcode_input: [],
  continue_without_audio_video_button: [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Continue without audio and video")',
    'button:has-text("マイクとカメラをオフにして参加")',
    'button:has-text("マイクとカメラなしで続行")',
    '[role="button"]:has-text("Continue without microphone and camera")',
  ],
  settings_button: [
    'button[aria-label*="Settings" i]',
    'button[aria-label*="設定" i]',
    'button:has-text("Settings")',
    'button:has-text("設定")',
    '[role="button"][aria-label*="Settings" i]',
  ],
  microphone_device_button: [
    'button[aria-label*="Microphone" i]',
    'button:has-text("Microphone")',
    'button:has-text("マイク")',
    '[role="button"][aria-label*="Microphone" i]',
  ],
  speaker_device_button: [
    'button[aria-label*="Speaker" i]',
    'button:has-text("Speaker")',
    'button:has-text("スピーカー")',
    '[role="button"][aria-label*="Speaker" i]',
  ],
  camera_device_button: [
    'button[aria-label*="Camera" i]',
    'button:has-text("Camera")',
    'button:has-text("カメラ")',
    '[role="button"][aria-label*="Camera" i]',
  ],
  device_option: [
    '[role="option"]',
    'button[role="menuitem"]',
    'button[role="option"]',
    '[role="menuitem"]',
  ],
  mute_mic_button: [
    // Confirmed via live DOM inspection 2026-05-26
    '[aria-label="Turn off microphone"]',
    '[aria-label="マイクをオフにする"]',
    'button[aria-label*="Microphone" i]',
    '[data-tooltip="マイクをオフにする"]',
  ],
  disable_camera_button: [
    // Confirmed via live DOM inspection 2026-05-26
    '[aria-label="Turn off camera"]',
    '[aria-label="カメラをオフにする"]',
    'button[aria-label*="Camera" i]',
    '[data-tooltip="カメラをオフにする"]',
  ],
  join_button: [
    // "Ask to join" = guest without host present; "Join now" = host or admitted
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("参加をリクエスト")',
    'button:has-text("今すぐ参加")',
    'button[jsname="Qx7uuf"]',
  ],
  leave_button: [
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="通話を終了"]',
    '[data-tooltip*="Leave" i]',
  ],
};

export const ZOOM_SELECTORS: MeetingPreJoinSelectors = {
  name_input: [
    // Confirmed via live DOM inspection 2026-05-26 (Zoom web client /wc/ endpoint)
    '#input-for-name',
    'input[aria-label="Your Name"]',
  ],
  meeting_id_input: [],
  meeting_passcode_input: [],
  continue_without_audio_video_button: [],
  settings_button: [],
  microphone_device_button: [],
  speaker_device_button: [],
  camera_device_button: [],
  device_option: [],
  mute_mic_button: [
    // Pre-join: aria-label="Mute" = mic is ON, clicking mutes it
    '#preview-audio-control-button',
    'button[aria-label="Mute"]',
    'button[aria-label="マイクをミュート"]',
  ],
  disable_camera_button: [
    // Pre-join: aria-label="Start Video" = video already off (no click needed)
    // If "Stop Video", click to disable
    '#preview-video-control-button',
    'button[aria-label="Stop Video"]',
    'button[aria-label="ビデオの停止"]',
  ],
  join_button: [
    '.preview-join-button',
    'button:has-text("Join")',
  ],
  leave_button: [
    // Post-join confirmed 2026-05-26
    'button[aria-label="Leave"]',
    'button:has-text("Leave")',
    'button[aria-label="退出"]',
  ],
};

export const TEAMS_SELECTORS: MeetingPreJoinSelectors = {
  name_input: [
    // Confirmed via live DOM inspection 2026-05-26 (light-meetings/launch experience)
    'input[data-tid="prejoin-display-name-input"]',
  ],
  meeting_id_input: [
    'input[aria-label*="会議 ID" i]',
    'input[placeholder*="会議 ID" i]',
    'input[aria-label*="Meeting ID" i]',
    'input[placeholder*="Meeting ID" i]',
    'input[data-tid="meeting-id-input"]',
  ],
  meeting_passcode_input: [
    'input[aria-label*="会議パスコード" i]',
    'input[placeholder*="会議パスコード" i]',
    'input[aria-label*="passcode" i]',
    'input[placeholder*="passcode" i]',
    'input[data-tid="meeting-passcode-input"]',
  ],
  continue_without_audio_video_button: [],
  settings_button: [],
  microphone_device_button: [],
  speaker_device_button: [],
  camera_device_button: [],
  device_option: [],
  mute_mic_button: [
    // checkbox input — click toggles mute state
    'input[data-tid="toggle-mute"]',
  ],
  disable_camera_button: [
    // checkbox input — click toggles camera state
    'input[data-tid="toggle-video"]',
  ],
  join_button: [
    'button:has-text("会議に参加する")',
    'button:has-text("Join the meeting")',
    'button[data-tid="prejoin-join-button"]',
    'button[id="prejoin-join-button"]',
  ],
  leave_button: [
    'button[data-tid="hangup-button"]',
    'button[aria-label*="Leave" i]',
    'button[aria-label*="通話を終了"]',
  ],
};

export function selectorsForPlatform(platform: MeetingPlatform): MeetingPreJoinSelectors {
  switch (platform) {
    case 'meet': return MEET_SELECTORS;
    case 'zoom': return ZOOM_SELECTORS;
    case 'teams': return TEAMS_SELECTORS;
    default: return MEET_SELECTORS;
  }
}
