/**
 * Selectors for the meeting platforms' pre-join and in-meeting UIs.
 * The selector data lives in the meeting platform registry
 * (`knowledge/product/governance/meeting-platforms.json`, RS-06) so a
 * deployment can update them without touching the driver runtime —
 * vendors update their DOM occasionally and this is the brittlest layer.
 * Localized vendor UI labels carry a `locale` tag in that data.
 *
 * Each entry names a CSS / role selector. The driver tries the list
 * in order until one resolves; the first hit wins. This makes it
 * easy to add fallback selectors as platforms re-skin.
 */

import type { MeetingPlatform } from '@agent/core/meeting/meeting-session-types';
import {
  defaultSelectorMeetingPlatform,
  findMeetingPlatform,
  resolveMeetingSelectorGroup,
  type MeetingPlatformDescriptor,
} from '@agent/core/meeting/meeting-platform-registry';

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

/**
 * In-meeting selectors for live-caption capture (`transcriptInput`).
 * Live-caption DOM is the brittlest layer after pre-join UI: vendors
 * re-skin it without notice, and caption availability depends on the
 * meeting (host must allow captions / transcription). Every list is
 * ordered best-effort-first and every entry is overridable per
 * deployment via `selectors_override`. When no container matches, the
 * driver reports `partial_state` instead of failing the session.
 */
export interface MeetingInMeetingSelectors {
  /** "Turn on captions / CC" toggle (best effort — may already be on). */
  captions_toggle: string[];
  /** Live-caption text region(s), polled for innerText. */
  captions_container: string[];
}

const preJoinCache = new Map<string, MeetingPreJoinSelectors>();
const inMeetingCache = new Map<string, MeetingInMeetingSelectors>();

/** Registered descriptor for a platform; unregistered ids (e.g. `auto`) use the registry default. */
function selectorDescriptor(platform: string): MeetingPlatformDescriptor {
  return findMeetingPlatform(platform) ?? defaultSelectorMeetingPlatform();
}

export function selectorsForPlatform(platform: MeetingPlatform | string): MeetingPreJoinSelectors {
  const descriptor = selectorDescriptor(platform);
  let selectors = preJoinCache.get(descriptor.id);
  if (!selectors) {
    selectors = resolveMeetingSelectorGroup(
      descriptor.pre_join_selectors
    ) as unknown as MeetingPreJoinSelectors;
    preJoinCache.set(descriptor.id, selectors);
  }
  return selectors;
}

export function inMeetingSelectorsForPlatform(
  platform: MeetingPlatform | string
): MeetingInMeetingSelectors {
  const descriptor = selectorDescriptor(platform);
  let selectors = inMeetingCache.get(descriptor.id);
  if (!selectors) {
    selectors = resolveMeetingSelectorGroup(
      descriptor.in_meeting_selectors
    ) as unknown as MeetingInMeetingSelectors;
    inMeetingCache.set(descriptor.id, selectors);
  }
  return selectors;
}

/** @deprecated Per-platform constants kept for compatibility; use selectorsForPlatform(). */
export const MEET_SELECTORS: MeetingPreJoinSelectors = selectorsForPlatform('meet');
/** @deprecated Use selectorsForPlatform('zoom'). */
export const ZOOM_SELECTORS: MeetingPreJoinSelectors = selectorsForPlatform('zoom');
/** @deprecated Use selectorsForPlatform('teams'). */
export const TEAMS_SELECTORS: MeetingPreJoinSelectors = selectorsForPlatform('teams');
/** @deprecated Use inMeetingSelectorsForPlatform('meet'). */
export const MEET_IN_MEETING_SELECTORS: MeetingInMeetingSelectors =
  inMeetingSelectorsForPlatform('meet');
/** @deprecated Use inMeetingSelectorsForPlatform('zoom'). */
export const ZOOM_IN_MEETING_SELECTORS: MeetingInMeetingSelectors =
  inMeetingSelectorsForPlatform('zoom');
/** @deprecated Use inMeetingSelectorsForPlatform('teams'). */
export const TEAMS_IN_MEETING_SELECTORS: MeetingInMeetingSelectors =
  inMeetingSelectorsForPlatform('teams');
