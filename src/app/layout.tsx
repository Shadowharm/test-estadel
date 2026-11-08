import type { Metadata } from "next";
import "@fontsource-variable/golos-text";
import { Providers } from "@/shared/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Мониторинг интеграций",
    template: "%s · Мониторинг интеграций",
  },
  description: "Журнал событий интеграций: поиск, фильтры и разбор ошибок.",
  robots: { index: false, follow: false },
};

export const runtime = "nodejs";
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
