import { describe, expect, it } from 'vitest';
import {
  allowableCommands,
  compileSafeRegex,
  scannableCommand,
  scannableUnits,
  simpleCommands,
} from './shell-command-normalize.js';

describe('shell-command-normalize (QM-05)', () => {
  describe('compileSafeRegex', () => {
    it('compiles plain patterns', () => {
      expect(compileSafeRegex('^git\\s+status').test('git status')).toBe(true);
      expect(compileSafeRegex('(?:^|\\s)rm\\s').test('sudo rm -rf /')).toBe(true);
    });

    it('rejects backreferences and lookarounds', () => {
      expect(() => compileSafeRegex('(a)\\1')).toThrowError(/backreferences/);
      expect(() => compileSafeRegex('(?=x)')).toThrowError(/backreferences|lookarounds/);
      expect(() => compileSafeRegex('(?<=x)y')).toThrowError(/backreferences|lookarounds/);
    });

    it('rejects nested and ambiguous repetition', () => {
      expect(() => compileSafeRegex('(a+)+')).toThrowError(/repetition/);
      expect(() => compileSafeRegex('(?:\\S+\\s+)*x')).toThrowError(/repetition/);
      expect(() => compileSafeRegex('a**')).toThrowError(/repetition/);
    });

    it('rejects oversized patterns', () => {
      expect(() => compileSafeRegex('a'.repeat(300))).toThrowError(/1-256/);
    });
  });

  describe('scannableCommand / scannableUnits', () => {
    it('decodes ANSI-C quoting', () => {
      expect(scannableCommand(`$'\\x72\\x6d' -rf /x`)).toContain('rm -rf /x');
    });

    it('extracts nested shell payloads recursively', () => {
      const units = scannableUnits(`bash -c "sh -c 'rm -rf /x'"`);
      expect(units.some((u) => u.includes('rm -rf /x'))).toBe(true);
    });

    it('extracts piped literal producers', () => {
      const units = scannableUnits(`echo 'rm -rf /x' | sh`);
      expect(units).toContain('rm -rf /x');
    });

    it('extracts here-strings and simple variable indirection', () => {
      expect(scannableUnits(`sh <<< 'rm -rf /x'`)).toContain('rm -rf /x');
      expect(scannableUnits('C=rm; $C -rf /x').some((u) => u.startsWith('rm '))).toBe(true);
    });

    it('keeps command substitutions visible', () => {
      const units = scannableUnits('echo "$(cat /etc/passwd)"');
      expect(units.some((u) => u.includes('cat /etc/passwd'))).toBe(true);
    });
  });

  describe('simpleCommands (wrapper unwrap for deny)', () => {
    it('unwraps wrapper chains to the core executable', () => {
      expect(simpleCommands('timeout -s KILL 30 rm -rf /x')[0]).toMatchObject({
        executable: 'rm',
      });
      expect(simpleCommands('sudo env A=1 nice -n 5 dd if=/dev/zero')[0]).toMatchObject({
        executable: 'dd',
      });
    });
  });

  describe('allowableCommands (strict allow path)', () => {
    it('returns the original spelling for plain commands', () => {
      expect(allowableCommands('git status')).toEqual([
        { executable: 'git', args: ['status'], display: 'git status' },
      ]);
    });

    it('refuses privilege wrappers', () => {
      expect(allowableCommands('sudo ls')).toBeNull();
      expect(allowableCommands('doas ls')).toBeNull();
      expect(allowableCommands('su -c ls')).toBeNull();
    });

    it('refuses unsafe env assignments, bare and via env', () => {
      expect(allowableCommands('PATH=/tmp/evil ls')).toBeNull();
      expect(allowableCommands('env LD_PRELOAD=/e.so cat f')).toBeNull();
      expect(allowableCommands('CI=1 ls')).toEqual([{ executable: 'ls', args: [], display: 'ls' }]);
      expect(allowableCommands('env CI=1 pnpm test')).toEqual([
        { executable: 'pnpm', args: ['test'], display: 'pnpm test' },
      ]);
    });

    it('refuses env with options', () => {
      expect(allowableCommands('env -S "ls -la"')).toBeNull();
      expect(allowableCommands('env -C /tmp ls')).toBeNull();
    });

    it('unwraps benign wrappers only', () => {
      expect(allowableCommands('timeout 30 git status')?.[0]?.display).toBe('git status');
      expect(allowableCommands('nohup nice -n 5 ls')?.[0]?.display).toBe('ls');
    });

    it('refuses write redirects anywhere in the command', () => {
      expect(allowableCommands('ls > out.txt')).toBeNull();
      expect(allowableCommands('cat a >> b')).toBeNull();
      expect(allowableCommands('ls 2> err.log')).toBeNull();
      expect(allowableCommands('cat < in.txt')).not.toBeNull();
    });

    it('refuses risky arguments to script-capable heads', () => {
      expect(allowableCommands(`awk 'BEGIN{system("x")}'`)).toBeNull();
      expect(allowableCommands(`awk '{print > "/etc/x"}'`)).toBeNull();
      expect(allowableCommands(`awk '{print $1}' file`)).not.toBeNull();
      expect(allowableCommands(`sed -i 's/a/b/' f`)).toBeNull();
      expect(allowableCommands(`sed 's/a/b/' f`)).not.toBeNull();
      expect(allowableCommands('find . -exec rm {} \\;')).toBeNull();
      expect(allowableCommands('find . -delete')).toBeNull();
      expect(allowableCommands('find . -name x')).not.toBeNull();
      expect(allowableCommands('sort -o out in')).toBeNull();
    });

    it('keeps path-qualified executables spelled as typed', () => {
      expect(allowableCommands('/tmp/evil/ls -la')?.[0]?.display).toBe('/tmp/evil/ls -la');
      expect(allowableCommands('./gradlew assembleDebug')?.[0]?.display).toBe(
        './gradlew assembleDebug'
      );
    });

    it('splits compound commands into candidates', () => {
      const candidates = allowableCommands('git status && git log');
      expect(candidates?.map((c) => c.display)).toEqual(['git status', 'git log']);
    });
  });
});
