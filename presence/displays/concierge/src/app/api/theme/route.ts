import { NextResponse } from 'next/server';
import { createConciergeWebThemePack, webThemePackToCssVars } from '@agent/core';

export const dynamic = 'force-dynamic';

export function GET() {
  const cssVars = webThemePackToCssVars(createConciergeWebThemePack());
  const body = `:root {\n${Object.entries(cssVars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')}\n}\n`;
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
