"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { captureException } from "@/lib/errorTracking";

/**
 * Global error boundary for the Next.js App Router.
 * Catches unhandled runtime errors, reports them via the errorTracking
 * module (Sentry when configured, console.error otherwise), and shows
 * a user-friendly fallback UI.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  useEffect(() => {
    captureException(error, { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h2 className="text-2xl font-semibold text-ink mb-4">
        {t("somethingWentWrong")}
      </h2>
      <p className="text-ink-muted mb-8 max-w-md">
        {t("unexpectedError")}
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-pevo-teal px-6 py-2 text-white hover:bg-pevo-teal-dark transition-colors"
      >
        {t("tryAgain")}
      </button>
    </div>
  );
}
