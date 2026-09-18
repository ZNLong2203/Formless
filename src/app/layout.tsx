import type { Metadata } from "next";
import { Fraunces, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// A printed manual's voice: a serif with real weight for headings, so a title
// reads as a title, and technical mono for everything the machine wrote.
// Instrument Serif ships a single weight, which left every heading the same
// thickness as body copy.
const serif = Fraunces({
  variable: "--font-serif",
  weight: ["600", "700"],
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono-sheet",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Formless",
  description:
    "The CRM that builds its own database. Forward a message; the schema grows to fit it.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
