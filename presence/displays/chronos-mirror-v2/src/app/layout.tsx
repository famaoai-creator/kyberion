import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chronos Mirror v2 | Kyberion",
  description: "The Sovereign Intelligent Interface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="bg-black text-kyberion-gold antialiased overflow-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
