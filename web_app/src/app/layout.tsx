import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapRiddle — AI Physical Riddle Party Game",
  description:
    "Point the ESP32-S3 camera, solve riddles in real time and let Gemini Vision judge your physical proof. Host dashboard + player phone controller.",
  keywords: ["SnapRiddle", "party game", "ESP32", "Gemini", "scavenger hunt", "realtime"],
  authors: [{ name: "SnapRiddle" }],
  // Metadata URLs are not basePath-prefixed, so add it for the Pages build.
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logo.svg` },
  openGraph: {
    title: "SnapRiddle",
    description: "AI-powered physical riddle scavenger hunt powered by ESP32-S3 + Gemini Vision.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b1120",
};

/** Applies the saved dark/light theme before first paint (no flash). */
const themeBootstrap = `(function(){try{var t=localStorage.getItem('snapriddle:theme');var dark=t!=='light';document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light';}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
