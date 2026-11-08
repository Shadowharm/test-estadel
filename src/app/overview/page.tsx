import { Suspense } from "react";
import { connection } from "next/server";
import { Workspace } from "@/features/journal/workspace";

export default async function OverviewPage() {
  await connection();
  return (
    <Suspense
      fallback={
        <main>
          <p role="status">Загружаем обзор…</p>
        </main>
      }
    >
      <Workspace />
    </Suspense>
  );
}
