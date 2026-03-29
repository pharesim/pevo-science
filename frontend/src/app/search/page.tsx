"use client";

import { Suspense } from "react";
import { useTranslations } from "next-intl";
import SearchContent from "./SearchContent";

export default function SearchPage() {
  const t = useTranslations("common");

  return (
    <Suspense
      fallback={
        <div className="container-narrow py-8">
          <div className="card text-center py-12">
            <p className="text-ink-muted">{t("loading")}</p>
          </div>
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
