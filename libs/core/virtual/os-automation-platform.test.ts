import { describe, expect, it, vi } from 'vitest';
import {
  createMouseOperationExecutor,
  resolveOsAutomationPlatform,
} from './os-automation-platform.js';

describe('resolveOsAutomationPlatform', () => {
  it('selects explicit platform adapters', () => {
    expect(resolveOsAutomationPlatform('darwin').setWindowState).toBeTypeOf('function');
    expect(resolveOsAutomationPlatform('darwin').isUIAutomationAvailable).toBeTypeOf('function');
    expect(resolveOsAutomationPlatform('win32').launchApplication).toBeTypeOf('function');
  });

  it('uses safe unsupported behavior instead of treating other OSes as macOS', () => {
    const adapter = resolveOsAutomationPlatform('linux');
    expect(adapter.launchApplication('editor')).toBe(false);
    expect(adapter.activateWindowByTitle('editor', 'Document')).toBe(false);
    expect(adapter.setWindowState('editor', 'Document', 'maximize')).toBe(false);
    expect(adapter.getWindowList('editor')).toEqual([]);
  });
});

describe('createMouseOperationExecutor', () => {
  it('maps generic pointer intent to native primitives', () => {
    const adapter = {
      moveMouse: vi.fn(),
      clickAt: vi.fn(),
      rightClickAt: vi.fn(),
      scrollAt: vi.fn(),
      dragFrom: vi.fn(),
    };
    const perform = createMouseOperationExecutor(adapter);

    perform({ type: 'move', x: 4, y: 8 });
    perform({ type: 'click', x: 10, y: 12, count: 2 });
    perform({ type: 'click', x: 20, y: 22, button: 'right' });
    perform({ type: 'scroll', x: 30, y: 32, direction: 'left', amount: 4 });
    perform({ type: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 });

    expect(adapter.moveMouse).toHaveBeenCalledWith(4, 8);
    expect(adapter.clickAt).toHaveBeenCalledWith(10, 12, 2);
    expect(adapter.rightClickAt).toHaveBeenCalledWith(20, 22, 1);
    expect(adapter.scrollAt).toHaveBeenCalledWith(30, 32, 'left', 4);
    expect(adapter.dragFrom).toHaveBeenCalledWith(1, 2, 3, 4);
  });
});
