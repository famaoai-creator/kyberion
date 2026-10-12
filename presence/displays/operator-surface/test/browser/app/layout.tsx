import type { ReactNode } from 'react';
import '../../../src/app/globals.css';
import '../../../src/app/kyberion-ui.css';
import '../../../src/app/operator.css';
export default function FixtureLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="operator-column">{children}</main>
      </body>
    </html>
  );
}
