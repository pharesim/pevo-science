"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { verifyAccreditation } from "@/lib/api";

type VerifyState = "loading" | "success" | "error";

function VerifyContent() {
  const t = useTranslations("verify");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [state, setState] = useState<VerifyState>("loading");
  const [resultUsername, setResultUsername] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setErrorMessage(t("noToken"));
      return;
    }

    verifyAccreditation(token)
      .then((res) => {
        setState("success");
        setResultUsername(res.data.username);
      })
      .catch((err) => {
        setState("error");
        setErrorMessage(err instanceof Error ? err.message : t("verificationFailed"));
      });
  }, [token, t]);

  return (
    <div className="container-narrow py-16 text-center">
      {state === "loading" && (
        <>
          <h1 className="text-2xl font-bold text-ink mb-4">{t("title")}</h1>
          <p className="text-ink-muted">{t("pleaseWait")}</p>
        </>
      )}

      {state === "success" && (
        <>
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-green-light mb-6">
            <svg className="h-8 w-8 text-pevo-green" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-ink mb-2">{t("confirmedTitle")}</h1>
          <p className="text-ink-muted mb-6">
            {t("confirmedMessage", { username: `@${resultUsername}` })}
          </p>
          <div className="flex gap-3 justify-center">
            <Link href={`/profile/${resultUsername}`} className="btn-primary no-underline">
              {t("viewProfile")}
            </Link>
            <Link href="/" className="btn-secondary no-underline">
              {t("browsePapers")}
            </Link>
          </div>
        </>
      )}

      {state === "error" && (
        <>
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-crimson-light mb-6">
            <svg className="h-8 w-8 text-pevo-crimson" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-ink mb-2">{t("failedTitle")}</h1>
          <p className="text-ink-muted mb-6">{errorMessage}</p>
          <Link href="/accreditation" className="btn-primary no-underline">
            {t("requestNew")}
          </Link>
        </>
      )}
    </div>
  );
}

export default function AccreditationVerifyPage() {
  const t = useTranslations("verify");

  return (
    <Suspense
      fallback={
        <div className="container-narrow py-16 text-center">
          <h1 className="text-2xl font-bold text-ink mb-4">{t("title")}</h1>
          <p className="text-ink-muted">{t("loading")}</p>
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
