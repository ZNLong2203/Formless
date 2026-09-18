import type { Metadata } from "next";
import { Geist_Mono, Instrument_Serif } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// A drafting sheet's title block: engraved serif for names and figures,
// technical mono for everything the machine wrote.
const serif = Instrument_Serif({
  variable: "--font-serif",
  weight: "400",
  style: ["normal", "italic"],
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
