/**
 * Visual Buffer Daemon v1.0
 * Maintains a rolling buffer of recent screen frames for temporal awareness.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, platform } from '../../libs/core/index.js';

const execAsync = promisify(exec);
const ROOT_DIR = process.cwd();
const FRAMES_DIR = path.join(ROOT_DIR, 'active/shared/runtime/vision/frames');
const STATE_FILE = path.join(ROOT_DIR, 'active/shared/runtime/vision/buffer-state.json');

const FRAME_INTERVAL_MS = Number(process.env.VISION_INTERVAL) || 1000;
const MAX_FRAMES = Number(process.env.VISION_MAX_FRAMES) || 10;

interface FrameMetadata {
  id: string;
  ts: string;
  file: string;
}

interface BufferState {
  lastUpdated: string;
  frames: FrameMetadata[];
}

async function captureFrame() {
  const timestamp = new Date().toISOString();
  const id = `frame-${Date.now()}`;
  const fileName = `${id}.jpg`;
  const filePath = path.join(FRAMES_DIR, fileName);

  try {
    // Uses platform-specific driver
    await platform.captureScreen(filePath);
    return { id, ts: timestamp, file: fileName };
  } catch (err: any) {
    logger.error(`[VisualBuffer] Capture failed: ${err.message}`);
    return null;
  }
}

async function maintenance(frames: FrameMetadata[]) {
  if (frames.length > MAX_FRAMES) {
    const toDelete = frames.splice(0, frames.length - MAX_FRAMES);
    for (const frame of toDelete) {
      const filePath = path.join(FRAMES_DIR, frame.file);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }
  }
  
  const state: BufferState = {
    lastUpdated: new Date().toISOString(),
    frames
  };
  
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function mainLoop() {
  logger.info(`🛡️ Visual Buffer Daemon active. Interval: ${FRAME_INTERVAL_MS}ms, Max Frames: ${MAX_FRAMES}`);
  
  if (!fs.existsSync(FRAMES_DIR)) {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
  }

  // Load existing state if any
  let frames: FrameMetadata[] = [];
  if (fs.existsSync(STATE_FILE)) {
    try {
      frames = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).frames;
    } catch (_) { frames = []; }
  }

  while (true) {
    const frame = await captureFrame();
    if (frame) {
      frames.push(frame);
      await maintenance(frames);
    }
    await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS));
  }
}

mainLoop().catch(err => {
  logger.error(`Visual Buffer Daemon crashed: ${err.message}`);
  process.exit(1);
});
