import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pictionary — Draw Together",
  description: "A collaborative drawing board for playing Pictionary with friends",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M22 4a4 4 0 0 1 5.6 5.6L12 25l-8 2.4 2.4-8Z' fill='%23586e75'/></svg>",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="h-full font-[family-name:var(--font-geist)]">
        {children}
      </body>
    </html>
  );
}
