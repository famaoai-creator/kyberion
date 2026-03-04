import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'node:fs';
import { safeUnlink, safeMkdir } from '@agent/core';
import { StrategicAction } from '@agent/core/shared-business-types';

export interface VoiceListenerOptions {
  workDir: string;
  audioFile: string;
}

export interface VoiceCommandResult {
  audioFile: string;
  command: string;
  action?: StrategicAction;
}

export function checkSoXInstalled(): boolean {
  try {
    execSync('sox --version', { stdio: 'ignore' });
    return true;
  } catch (_e) {
    return false;
  }
}

export function startRecording(options: VoiceListenerOptions): ChildProcess {
  if (!fs.existsSync(options.workDir)) {
    safeMkdir(options.workDir, { recursive: true });
  }

  if (!checkSoXInstalled()) {
    throw new Error(
      'SoX ("rec" command) is not installed. Please install it using "brew install sox" or equivalent.'
    );
  }

  const rec = spawn('rec', ['-q', '-c', '1', '-r', '16000', options.audioFile]);

  // Basic signal handling for the child process
  const cleanup = () => {
    if (!rec.killed) rec.kill('SIGKILL');
    if (fs.existsSync(options.audioFile)) {
      try {
        safeUnlink(options.audioFile);
      } catch (_e) {
        /* ignore */
      }
    }
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  rec.on('exit', () => {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  });

  return rec;
}

/**
 * Maps a plain text command to a structured StrategicAction.
 */
export function mapCommandToAction(command: string): StrategicAction {
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  let area = 'General';

  if (command.match(/security|audit|risk/i)) {
    priority = 'high';
    area = 'Security';
  } else if (command.match(/financial|report|revenue/i)) {
    area = 'Finance';
  }

  return {
    action: command,
    priority,
    area,
  };
}

export async function transcribeMock(audioFile: string): Promise<string> {
  // Simulating Whisper API for now
  const mockCommands = [
    'Run a security audit on the production environment.',
    'Generate a quarterly financial report.',
    'What is the status of the Jira backlog?',
  ];
  return mockCommands[Math.floor(Math.random() * mockCommands.length)];
}
