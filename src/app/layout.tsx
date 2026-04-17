import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/layout/app-shell';
import { Toaster } from '@/components/ui/sonner';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

// Cal Sans SemiBold: once you drop CalSans-SemiBold.woff2 into src/app/fonts/,
// uncomment the import+loader below and add `${calSans.variable}` to <html>.
// Until then --font-display falls back to Inter (see globals.css).
// import localFont from 'next/font/local';
// const calSans = localFont({
//   src: './fonts/CalSans-SemiBold.woff2',
//   variable: '--font-display',
//   display: 'swap',
//   weight: '600',
// });

export const metadata: Metadata = {
  title: 'Proxi CRM',
  description: 'Internal CRM for Proxi AI outbound discovery',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable}`}
    >
      <body>
        <AppShell>{children}</AppShell>
        <Toaster />
      </body>
    </html>
  );
}
