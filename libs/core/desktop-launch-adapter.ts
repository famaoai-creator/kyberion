import { safeExec } from './secure-io.js';

export interface DesktopLaunchAdapter {
  open(target: string, cwd?: string): void;
}
const adapters: Partial<Record<NodeJS.Platform, DesktopLaunchAdapter>> = {
  darwin: { open: (target, cwd) => safeExec('open', [target], { cwd }) },
  linux: { open: (target, cwd) => safeExec('xdg-open', [target], { cwd }) },
  win32: { open: (target, cwd) => safeExec('cmd', ['/c', 'start', '', target], { cwd }) },
};
export function resolveDesktopLaunchAdapter(): DesktopLaunchAdapter {
  return (
    adapters[process.platform] || {
      open: () => {
        throw new Error(`desktop launch unsupported on ${process.platform}`);
      },
    }
  );
}
