"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { completeOrcidVerification } from "@/lib/api";
import { useToast } from "@/components/Toast";
import Link from "next/link";

export default function OrcidCallbackPage() {
  const t = useTranslations("orcid");
  const searchParams = useSearchParams();
  const { username, isConnected, connect } = useAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<"pending" | "verifying" | "success" | "error">("pending");
  const [errorMessage, setErrorMessage] = useState("");
  const [orcidId, setOrcidId] = useState("");

  const code = searchParams.get("code");
  const state = searchParams.get("state");

  useEffect(() => {
    if (!code || !state) {
      setStatus("error");
      setErrorMessage(t("missingParams"));
      return;
    }

    if (!isConnected || !username) return;

    if (status !== "pending") return;

    const verify = async () => {
      try {
        setStatus("verifying");
        const res = await completeOrcidVerification(code, state);

        setOrcidId(res.data.orcid);
        setStatus("success");
        toast(t("verificationSuccess"), "success");
      } catch (err) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : t("verificationFailed"));
      }
    };

    verify();
  }, [code, state, isConnected, username, status, toast, t]);

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink mb-4">{t("callbackTitle")}</h1>

      {!isConnected && (
        <div className="card">
          <p className="text-ink-muted mb-4">{t("connectToComplete")}</p>
          <button className="btn-primary" onClick={connect}>
            {t("connectWallet")}
          </button>
        </div>
      )}

      {status === "verifying" && (
        <div className="card">
          <p className="text-ink-muted">{t("verifyingOrcid")}</p>
        </div>
      )}

      {status === "success" && (
        <div className="card bg-pevo-green-light border border-pevo-green/30">
          <p className="text-sm font-medium text-pevo-green-dark mb-2">{t("verificationSuccess")}</p>
          {orcidId && <p className="text-sm text-ink-muted">{t("orcidId")}: {orcidId}</p>}
          <Link href="/profile" className="btn-primary inline-block mt-4">
            {t("viewProfile")}
          </Link>
        </div>
      )}

      {status === "error" && (
        <div className="card bg-pevo-crimson-light border border-pevo-crimson/30">
          <p className="text-sm font-medium text-pevo-crimson-dark mb-2">{errorMessage}</p>
          <Link href="/accreditation" className="btn-secondary inline-block mt-4">
            {t("tryAgain")}
          </Link>
        </div>
      )}
    </div>
  );
}
