#!/usr/bin/env node
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StubAudioBus, pathResolver, logger } from '@agent/core';
import { createBrowserMeetingJoinDriver } from '../../../../dist/libs/actuators/meeting-browser-driver/src/index.js';

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) return raw;
  } catch {
    // fall through to argv
  }
  if (process.argv[2]) return process.argv[2];
  return '';
}

function parsePayload() {
  const raw = readPayload();
  if (!raw.trim()) {
    throw new Error('missing input payload');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON input: ${message}`);
  }
}

function normalizePlatform(platform, url) {
  const value = String(platform || 'auto').trim();
  if (value && value !== 'auto') return value;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  if (host.includes('zoom.us') || host.includes('zoom.com')) return 'zoom';
  if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) return 'teams';
  if (host.includes('meet.google.com')) return 'meet';
  return 'meet';
}

async function runJoin(params = {}) {
  const url = String(params.url || '').trim();
  if (!url) {
    return { status: 'error', message: 'params.url is required' };
  }

  const platform = normalizePlatform(params.platform, url);
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
  if (durationSec > 0) {
    await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
  }

  await session.leave();

  return {
    status: 'success',
    platform,
    join_backend: driver.driver_id,
    message: `joined and left ${platform}`,
    partial_state: false,
  };
}

async function main() {
  let payload;
  try {
    payload = parsePayload();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  }

  const action = payload?.action || 'join';
  const params = payload?.params || {};

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

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (entrypoint && modulePath === entrypoint) {
  await main();
}
