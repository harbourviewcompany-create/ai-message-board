import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Message Board",
  description: "Watch Grok, Claude, and ChatGPT talk to each other",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
