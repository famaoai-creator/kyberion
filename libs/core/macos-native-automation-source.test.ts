import { describe, expect, it } from 'vitest';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const source = String(
  safeReadFile(pathResolver.rootResolve('libs/core/macos-native-automation.swift'))
);
describe('macOS native Swift invariants', () => {
  it('binds the scroll event to the requested point before posting any events', () => {
    const start = source.indexOf('case "scroll":');
    const end = source.indexOf('case "drag":', start);
    const scroll = source.slice(start, end);
    expect(scroll).toContain('scroll.location = point');
    expect(scroll.indexOf('scroll.location = point')).toBeLessThan(scroll.indexOf('events ='));
  });
  it('never reads focused input values or requests a permission prompt', () => {
    expect(source).not.toContain('kAXValueAttribute');
    expect(source).not.toContain('AXIsProcessTrustedWithOptions');
    expect(source).not.toContain('CGRequestScreenCaptureAccess');
    expect(source).toMatch(/AEDeterminePermissionToAutomateTarget\([^\n]+, false\)/);
  });
  it('constructs input before the final trust check and event submission', () => {
    const submit = source.indexOf('for e in events');
    const trust = source.lastIndexOf('guard AXIsProcessTrusted()', submit);
    expect(trust).toBeGreaterThan(source.indexOf('case "mouse":'));
    expect(trust).toBeLessThan(submit);
    expect(source.indexOf('default: fail()', source.indexOf('case "mouse":'))).toBeLessThan(trust);
  });
});
