import "./globals.css";

export const metadata = {
  title: "Undertone — real-time audio intelligence",
  description: "Live transcription and routed meeting suggestions on a serverless AWS platform.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
