#!/usr/bin/env node
import path from 'node:path';
import { isDirectEntry } from '@agent/core/direct-entry';
import { StubAudioBus } from '@agent/core/audio-bus';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import {
  resolveMeetingPlatformFromUrl,
  validateMeetingTarget,
} from '@agent/core/meeting-join-driver';
import { createBrowserMeetingJoinDriver } from '../../../../dist/libs/actuators/meeting-browser-driver/src/index.js';

async function readPayload() {
  let raw = '';
  try {
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) raw += String(chunk);
    }
  } catch {
    // fall through to argv
  }
  return raw.trim() ? raw : process.argv[2] || '';
}

async function parsePayload() {
  const raw = await readPayload();
  if (!raw.trim()) {
    throw new Error('missing input payload');
  }
  return parseSafeJsonObjectValue(parseSafeJsonInput(raw, 'meeting input'), 'meeting input');
}

function normalizePlatform(platform, url) {
  const value = String(platform || 'auto').trim();
  if (value && value !== 'auto') return value;
  return resolveMeetingPlatformFromUrl(url) || 'meet';
}

async function runJoin(params = {}) {
  const url = String(params.url || '').trim();
  if (!url) {
    return { status: 'error', message: 'params.url is required' };
  }

  const platform = normalizePlatform(params.platform, url);
  try {
    validateMeetingTarget({
      url,
      platform,
      meeting_id: params.meeting_id,
      passcode: params.passcode,
      display_name: params.name || params.display_name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', platform, message };
  }
  const driver = createBrowserMeetingJoinDriver({
    account_slug: params.account_slug || params.profile_id || 'default',
    headed: Boolean(params.headed),
    user_data_dir: params.user_data_dir,
    profile_directory: params.profile_directory,
    connect_over_cdp: Boolean(params.connect_over_cdp),
    cdp_url: params.cdp_url,
    cdp_port: params.cdp_port,
    browser_channel: params.browser_channel,
    microphone_device: params.microphone_device,
    speaker_device: params.speaker_device,
    camera_device: params.camera_device,
    step_timeout_ms: params.step_timeout_ms,
    enable_captions: params.enable_captions !== false,
    caption_poll_ms: params.caption_poll_ms,
    in_meeting_selectors_override: params.in_meeting_selectors_override,
  });

  const probe = await driver.probe();
  if (!probe.available) {
    return { status: 'error', platform, message: probe.reason || 'playwright unavailable' };
  }

  const bus = new StubAudioBus();
  const session = await driver.join(
    {
      platform,
      url,
      meeting_id: params.meeting_id,
      passcode: params.passcode,
      display_name: params.name || params.display_name,
    },
    bus
  );

  const durationSec = Math.max(
    0,
    Number.parseInt(String(params.wait ?? params.duration_sec ?? 0), 10) || 0
  );

  // Live-caption capture while the session is open. The transcript file
  // uses `[mm:ss] Speaker: text` lines so `meeting:normalize_transcript`
  // passes it straight through into meeting-followup.
  const transcriptPath = String(params.transcript_path || '').trim();
  const cues = [];
  const t0 = Date.now();
  let captionsAvailable = false;
  if (transcriptPath && durationSec > 0 && typeof session.transcriptInput === 'function') {
    const deadline = t0 + durationSec * 1000;
    try {
      const consume = (async () => {
        for await (const chunk of session.transcriptInput()) {
          captionsAvailable = true;
          cues.push({
            tSec: Math.max(0, Math.round((Date.now() - t0) / 1000)),
            speaker: chunk.speaker_label || '',
            text: chunk.text || '',
          });
        }
      })();
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await session.leave();
      // Drain briefly so trailing captions flush.
      await Promise.race([consume, new Promise((resolve) => setTimeout(resolve, 2000))]);
    } catch (err) {
      logger.error(`[playwright-meet-join] caption capture failed: ${err?.message ?? err}`);
    }
  } else {
    if (durationSec > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
    }
    await session.leave();
  }

  let transcript_written = false;
  if (transcriptPath && cues.length > 0) {
    const lines = cues
      .filter((cue) => cue.text.trim())
      .map(
        (cue) =>
          `[${String(Math.floor(cue.tSec / 60)).padStart(2, '0')}:${String(cue.tSec % 60).padStart(2, '0')}] ${cue.speaker.trim() || 'Unknown'}: ${cue.text.trim()}`
      );
    const safeTranscriptPath = assertSafeRepositoryPath(path.resolve(transcriptPath), {
      allowMissingLeaf: true,
    });
    safeMkdir(path.dirname(safeTranscriptPath), { recursive: true });
    safeWriteFile(safeTranscriptPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
    transcript_written = lines.length > 0;
  }

  const result = {
    status: 'success',
    platform,
    join_backend: driver.driver_id,
    message: `joined and left ${platform}`,
    partial_state: transcriptPath ? !transcript_written : false,
  };
  if (transcriptPath) {
    result.transcript_path = transcriptPath;
    result.caption_cues = cues.length;
    result.captions_available = captionsAvailable;
    if (!transcript_written) {
      result.partial_reason = 'no live captions captured (see selectors_override)';
    }
  }
  return result;
}

async function main() {
  let payload;
  let params;
  try {
    payload = await parsePayload();
    params = parseSafeJsonObjectValue(
      payload.params === undefined ? {} : payload.params,
      'meeting params'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ status: 'error', message }));
    process.exit(1);
  }

  const action = typeof payload.action === 'string' ? payload.action : 'join';

  try {
    let result;
    if (action === 'join') {
      result = await runJoin(params);
    } else if (action === 'status') {
      result = {
        status: 'success',
        action: 'status',
        platform: String(params.platform || 'auto'),
        join_backend: 'meeting-browser-driver',
      };
    } else if (action === 'leave') {
      result = {
        status: 'success',
        action: 'leave',
        method: 'session_ended',
      };
    } else {
      result = {
        status: 'error',
        message: `unsupported action: ${action}`,
      };
    }
    console.log(JSON.stringify(result));
    if (result.status !== 'success') {
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[playwright-meet-join] ${message}`);
    console.log(JSON.stringify({ status: 'error', message }));
    process.exit(1);
  }
}

if (
  isDirectEntry(
    import.meta.url,
    'libs/actuators/meeting-browser-driver/scripts/playwright-meet-join.mjs'
  )
) {
  await main();
}
