import "./globals.css";
import type { ReactNode } from "react";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { AmbientBackground } from "../components/AmbientBackground";
import { ScrollProgress } from "../components/ScrollProgress";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "CREDIT — Agent-to-Agent Lending on Locus",
  description:
    "Autonomous USDC lending for AI agents. Powered by Locus Checkout.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="bg-panel text-ink min-h-screen relative">
        <AmbientBackground />
        <ScrollProgress />
        {children}
      </body>
    </html>
  );
}
