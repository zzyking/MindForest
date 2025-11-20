import type { Metadata } from "next";
import { Inter, Crimson_Pro } from "next/font/google";
import "./globals.css";

// 1. Configure Fonts with CSS Variables
const inter = Inter({ 
  subsets: ["latin"], 
  variable: "--font-inter", // Matches --font-sans in CSS
  display: "swap",
});

const crimson = Crimson_Pro({ 
  subsets: ["latin"], 
  variable: "--font-crimson", // Matches --font-serif in CSS
  display: "swap",
});

export const metadata: Metadata = {
  title: "MindForest",
  description: "Cultivate your knowledge.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${crimson.variable} antialiased`}>
        
        {/* Texture Overlay using our new v4 utility */}
        <div className="fixed inset-0 z-0 opacity-[0.03] pointer-events-none mix-blend-multiply bg-noise" />
        
        <div className="relative z-10 h-full w-full">
          {children}
        </div>
      </body>
    </html>
  );
}