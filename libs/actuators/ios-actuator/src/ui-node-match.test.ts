import { describe, expect, it } from 'vitest';
import { findAxeNode } from './ios-runtime-helpers.js';

const TREE = {
  role: 'Application',
  children: [
    {
      role: 'Window',
      children: [
        {
          role: 'Button',
          label: 'Sign in',
          identifier: 'login-button',
          frame: { x: 20, y: 400, width: 160, height: 44 },
        },
        {
          role: 'StaticText',
          label: 'Welcome back',
          frame: { x: 30, y: 120, width: 200, height: 20 },
        },
      ],
    },
  ],
};

describe('findAxeNode', () => {
  it('matches an identifier and returns the frame center', () => {
    const hit = findAxeNode(TREE, { text: '', identifier: 'login-button' });
    expect(hit?.center).toEqual({ x: 100, y: 422 });
    expect(hit?.identifier).toBe('login-button');
  });

  it('matches a label substring case-insensitively', () => {
    const hit = findAxeNode(TREE, { text: 'sign in', identifier: '' });
    expect(hit?.label).toBe('Sign in');
  });

  it('supports flat top-level x/y/width/height shapes', () => {
    const flat = [{ label: 'OK', x: 10, y: 10, width: 40, height: 20 }];
    const hit = findAxeNode(flat, { text: 'ok', identifier: '' });
    expect(hit?.center).toEqual({ x: 30, y: 20 });
  });

  it('returns null when nothing matches', () => {
    expect(findAxeNode(TREE, { text: 'nonexistent', identifier: '' })).toBeNull();
  });
});

describe('op catalog registration', () => {
  it('advertises the interactive + stream ops added by MSN-MOBILE-ACT-20261028', async () => {
    const { describeOps } = await import('./op-catalog.js');
    const names = new Set(describeOps().map((d) => (d as { op?: string }).op));
    for (const step of [
      { op: 'describe_ui' },
      { op: 'tap' },
      { op: 'tap_ui_node' },
      { op: 'swipe' },
      { op: 'input_text' },
      { op: 'press_button' },
      { op: 'start_screen_stream' },
      { op: 'stop_screen_stream' },
      { op: 'stream_status' },
    ]) {
      expect(names.has(step.op), `op ${step.op}`).toBe(true);
    }
  });
});
