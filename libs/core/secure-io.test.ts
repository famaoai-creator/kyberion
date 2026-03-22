import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { 
  validateFileSize, 
  buildSafeExecEnv,
  safeReadFile, 
  safeWriteFile, 
  sanitizePath, 
  validateUrl 
} from './secure-io.js';

describe('secure-io core', () => {
  let tmpDir: string;

  beforeEach(() => {
    const tmpRoot = path.join(process.cwd(), 'active', 'shared', 'tmp', 'tests');
    if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'secure-io-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('validateFileSize', () => {
    it('should return size for a small file', () => {
      const testFile = path.join(tmpDir, 'small.txt');
      fs.writeFileSync(testFile, 'Hello, World!');
      const size = validateFileSize(testFile);
      expect(size).toBe(13);
    });

    it('should throw for oversized file', () => {
      const testFile = path.join(tmpDir, 'large.txt');
      fs.writeFileSync(testFile, 'x'.repeat(100));
      expect(() => validateFileSize(testFile, 0.00001)).toThrow('File too large');
    });
  });

  describe('safeReadFile', () => {
    it('should read a valid file', () => {
      const testFile = path.join(tmpDir, 'read.txt');
      fs.writeFileSync(testFile, 'Safe content');
      const content = safeReadFile(testFile);
      expect(content.toString()).toBe('Safe content');
    });

    it('should throw for missing file', () => {
      expect(() => safeReadFile(path.join(tmpDir, 'missing.txt'))).toThrow('File not found');
    });

    it('should throw for empty path', () => {
      expect(() => safeReadFile('')).toThrow('Missing required');
    });
  });

  describe('safeWriteFile', () => {
    it('should perform atomic write and clean up temp files', () => {
      const testFile = path.join(tmpDir, 'atomic.txt');
      safeWriteFile(testFile, 'initial');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('initial');

      safeWriteFile(testFile, 'updated');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('updated');

      const files = fs.readdirSync(tmpDir);
      const tempFiles = files.filter(f => f.includes('atomic.txt.tmp'));
      expect(tempFiles.length).toBe(0);
    });
  });

  describe('sanitizePath', () => {
    it('should remove path traversal and leading slashes', () => {
      expect(sanitizePath('../etc/passwd')).toBe('etc/passwd');
      expect(sanitizePath('..\\windows\\system32')).toBe('windows\\system32');
      expect(sanitizePath('/absolute/path')).toBe('absolute/path');
      expect(sanitizePath('safe/path/file.txt')).toBe('safe/path/file.txt');
    });

    it('should remove null bytes', () => {
      expect(sanitizePath('file\0name.txt')).toBe('filename.txt');
    });

    it('should handle empty or null input', () => {
      expect(sanitizePath('')).toBe('');
      expect(sanitizePath(null as any)).toBe('');
    });
  });

  describe('validateUrl', () => {
    it('should accept valid HTTPS URL', () => {
      const url = 'https://example.com/api';
      expect(validateUrl(url)).toBe(url);
    });

    it('should block localhost and loopback', () => {
      expect(() => validateUrl('http://localhost:3000')).toThrow('Blocked URL');
      expect(() => validateUrl('http://127.0.0.1:8080')).toThrow('Blocked URL');
    });

    it('should block private IP ranges', () => {
      expect(() => validateUrl('http://10.0.0.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://127.0.0.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://169.254.1.10')).toThrow('Blocked URL');
      expect(() => validateUrl('http://192.168.1.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://172.16.0.1')).toThrow('Blocked URL');
    });

    it('should block private and loopback IPv6 ranges', () => {
      expect(() => validateUrl('http://[::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[fd00::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[fe80::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[::ffff:127.0.0.1]')).toThrow('Blocked URL');
    });

    it('should reject non-HTTP protocols', () => {
      expect(() => validateUrl('ftp://example.com')).toThrow('Unsupported protocol');
    });

    it('should reject invalid URLs', () => {
      expect(() => validateUrl('not-a-url')).toThrow('Invalid URL');
    });

    it('should throw for empty input', () => {
      expect(() => validateUrl('')).toThrow('Missing or invalid URL');
    });
  });

  describe('buildSafeExecEnv', () => {
    it('should only inherit allowlisted variables by default', () => {
      process.env.OPENAI_API_KEY = 'secret-openai-key';
      process.env.PATH = process.env.PATH || '/usr/bin';
      process.env.CUSTOM_SECRET = 'should-not-leak';

      const env = buildSafeExecEnv();

      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CUSTOM_SECRET).toBeUndefined();
    });

    it('should allow explicit env overrides when needed', () => {
      const env = buildSafeExecEnv({ CUSTOM_SECRET: 'explicit-only', MISSION_ID: 'MSN-1' });

      expect(env.CUSTOM_SECRET).toBe('explicit-only');
      expect(env.MISSION_ID).toBe('MSN-1');
    });
  });
});
