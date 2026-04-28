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
    'input[aria-label="Your name"]',
    'input[aria-label="名前"]',
  ],
  mute_mic_button: [
    'div[role="button"][aria-label*="microphone" i][data-is-muted="false"]',
    'div[role="button"][aria-label*="マイク"][aria-pressed="true"]',
  ],
  disable_camera_button: [
    'div[role="button"][aria-label*="camera" i][data-is-muted="false"]',
    'div[role="button"][aria-label*="カメラ"][aria-pressed="true"]',
  ],
  join_button: [
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("参加をリクエスト")',
    'button:has-text("今すぐ参加")',
  ],
  leave_button: [
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="通話を終了"]',
  ],
};

export const ZOOM_SELECTORS: MeetingPreJoinSelectors = {
  name_input: [
    'input#inputname',
    'input[aria-label="Your Name"]',
  ],
  mute_mic_button: [
    'button[aria-label*="mute" i][aria-pressed="false"]',
  ],
  disable_camera_button: [
    'button[aria-label*="camera" i][aria-pressed="false"]',
  ],
  join_button: [
    'button:has-text("Join")',
    'button#joinBtn',
  ],
  leave_button: [
    'button[aria-label*="Leave" i]',
  ],
};

export const TEAMS_SELECTORS: MeetingPreJoinSelectors = {
  name_input: [
    'input[data-tid="prejoin-display-name-input"]',
  ],
  mute_mic_button: [
    'button[data-tid="toggle-mute"]',
  ],
  disable_camera_button: [
    'button[data-tid="toggle-video"]',
  ],
  join_button: [
    'button[data-tid="prejoin-join-button"]',
  ],
  leave_button: [
    'button[data-tid="hangup-button"]',
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
