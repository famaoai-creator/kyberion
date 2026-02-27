import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkSoXInstalled, startRecording, transcribeMock, mapCommandToAction } from './lib.js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';

vi.mock('child_process');
vi.mock('fs');

describe('voice-command-listener lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect if SoX is installed', () => {
    vi.mocked(execSync).mockReturnValue('sox: SoX v14.4.2' as any);
    expect(checkSoXInstalled()).toBe(true);

    vi.mocked(execSync).mockImplementation(() => {
      throw new Error();
    });
    expect(checkSoXInstalled()).toBe(false);
  });

  it('should throw error if SoX is not installed when starting recording', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error();
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    expect(() => startRecording({ workDir: '/test', audioFile: 'test.wav' })).toThrow(
      'SoX ("rec" command) is not installed'
    );
  });

  it('should start recording process with correct arguments', () => {
    vi.mocked(execSync).mockReturnValue('sox: SoX v14.4.2' as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue({ on: vi.fn(), once: vi.fn() } as any);

    startRecording({ workDir: '/test', audioFile: 'test.wav' });
    expect(spawn).toHaveBeenCalledWith('rec', ['-q', '-c', '1', '-r', '16000', 'test.wav']);
  });

  it('should return a mock command when transcribing', async () => {
    const command = await transcribeMock('dummy.wav');
    expect(typeof command).toBe('string');
    expect(command.length).toBeGreaterThan(0);
  });

  it('should map string command to structured StrategicAction', () => {
    const action = mapCommandToAction('Run security audit');
    expect(action.priority).toBe('high');
    expect(action.area).toBe('Security');
    expect(action.action).toBe('Run security audit');
  });
});
