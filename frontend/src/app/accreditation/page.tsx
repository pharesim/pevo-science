"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { requestAccreditation, startOrcidVerification } from "@/lib/api";
import { useToast } from "@/components/Toast";

type SubmitStep = "idle" | "submitting" | "success" | "error";

export default function AccreditationPage() {
  const t = useTranslations("accreditation");
  const tCommon = useTranslations("common");
  const { username, isConnected, connect } = useAuth();
  const { toast } = useToast();

  const [fullName, setFullName] = useState("");
  const [institution, setInstitution] = useState("");
  const [field, setField] = useState("");
  const [email, setEmail] = useState("");
  const [orcid, setOrcid] = useState("");

  const [step, setStep] = useState<SubmitStep>("idle");
  const [resultMessage, setResultMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [orcidLoading, setOrcidLoading] = useState(false);

  const tOrcid = useTranslations("orcid");

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : tCommon("connectionFailed");
      toast(message, "error");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !isConnected) return;

    setStep("submitting");
    setErrorMessage("");

    try {
      const payload = {
        full_name: fullName,
        institution,
        field,
        email,
        orcid: orcid || "",
      };

      const res = await requestAccreditation(payload);

      setStep("success");
      setResultMessage(res.data.message);
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : "Accreditation request failed");
    }
  };

  const handleOrcidVerify = async () => {
    if (!username || !isConnected) return;
    setOrcidLoading(true);
    setErrorMessage("");
    try {
      const { redirect_url } = await startOrcidVerification();
      window.location.href = redirect_url;
    } catch (err) {
      const message = err instanceof Error ? err.message : "ORCID verification failed";
      toast(message, "error");
      setOrcidLoading(false);
    }
  };

  const isSubmitting = step === "submitting";

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink mb-2">
        {t("title")}
      </h1>
      <p className="text-ink-muted mb-8">
        {t("description")}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="text-section-title text-ink mb-3 font-serif">
            {t("whyTitle")}
          </h2>
          <p className="text-sm text-ink-muted leading-relaxed">
            {t("whyDescription")}
          </p>
        </div>

        <div className="card">
          <h2 className="text-section-title text-ink mb-3 font-serif">
            {t("howTitle")}
          </h2>
          <ol className="text-sm text-ink-muted leading-relaxed space-y-2 list-decimal list-inside">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
            <li>{t("step3")}</li>
            <li>{t("step4")}</li>
          </ol>
          <div className="mt-4 pt-3 border-t border-parchment-dark">
            <p className="text-sm text-ink-muted leading-relaxed">
              <strong className="text-ink">{t("wotAlternative")}</strong>{" "}
              {t("wotDescription", {
                count: 3,
                profileLink: t("profilePage"),
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="card mt-6">
        <h2 className="text-section-title text-ink mb-4 font-serif">
          {t("requestTitle")}
        </h2>

        {!isConnected && (
          <div className="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <svg className="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              <div>
                <p className="font-medium text-ink text-sm">{t("walletNotConnected")}</p>
                <p className="text-xs text-ink-muted mt-1">
                  {t("walletHint")}
                </p>
                <button className="btn-primary text-xs mt-2" onClick={handleConnect}>
                  {tCommon("connectWallet")}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "success" && (
          <div className="bg-pevo-green-light border border-pevo-green/30 rounded-lg p-4 mb-6">
            <p className="text-sm font-medium text-pevo-green-dark">{resultMessage}</p>
            <p className="text-xs text-pevo-green-dark/80 mt-1">{t("checkEmail")}</p>
          </div>
        )}

        {step === "error" && (
          <div className="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4 mb-6">
            <p className="text-sm font-medium text-pevo-crimson-dark">{errorMessage}</p>
            <button className="btn-secondary text-xs mt-2" onClick={() => setStep("idle")}>
              {t("tryAgain")}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="full-name" className="block text-sm font-medium text-ink mb-1">
                {t("fullName")}
              </label>
              <input
                id="full-name"
                type="text"
                className="select-control"
                placeholder={t("namePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="institution" className="block text-sm font-medium text-ink mb-1">
                {t("institution")}
              </label>
              <input
                id="institution"
                type="text"
                className="select-control"
                placeholder={t("institutionPlaceholder")}
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="field" className="block text-sm font-medium text-ink mb-1">
                {t("fieldOfResearch")}
              </label>
              <input
                id="field"
                type="text"
                className="select-control"
                placeholder={t("fieldPlaceholder")}
                value={field}
                onChange={(e) => setField(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="orcid" className="block text-sm font-medium text-ink mb-1">
                {t("orcidOptional")}
              </label>
              <input
                id="orcid"
                type="text"
                className="select-control"
                placeholder={t("orcidPlaceholder")}
                value={orcid}
                onChange={(e) => setOrcid(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink mb-1">
              {t("email")}
            </label>
            <input
              id="email"
              type="email"
              className="select-control"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="text-xs text-ink-muted mt-1">
              {t("emailHint")}
            </p>
          </div>

          <div className="pt-2 flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              className="btn-primary"
              disabled={!isConnected || isSubmitting || step === "success"}
            >
              {!isConnected
                ? t("connectToBegin")
                : step === "submitting"
                ? t("submittingRequest")
                : t("submitButton")}
            </button>

            <span className="text-sm text-ink-muted self-center">{tOrcid("or")}</span>

            <button
              type="button"
              className="btn-secondary flex items-center gap-2"
              disabled={!isConnected || orcidLoading || step === "success"}
              onClick={handleOrcidVerify}
            >
              <svg className="h-4 w-4" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M256 128C256 198.692 198.692 256 128 256C57.3076 256 0 198.692 0 128C0 57.3076 57.3076 0 128 0C198.692 0 256 57.3076 256 128Z" fill="#A6CE39"/>
                <path d="M86.3 186.2H70.9V79.1H86.3V186.2ZM78.6 56.1C73.5 56.1 69.4 60.2 69.4 65.3C69.4 70.4 73.5 74.5 78.6 74.5C83.7 74.5 87.8 70.4 87.8 65.3C87.8 60.2 83.7 56.1 78.6 56.1ZM108.5 79.1H150.3C185 79.1 200.5 102.7 200.5 132.6C200.5 165.2 181.5 186.2 150.3 186.2H108.5V79.1ZM124 172.5H148.6C175.2 172.5 184.6 153.3 184.6 132.6C184.6 110.6 173.8 92.8 148.6 92.8H124V172.5Z" fill="white"/>
              </svg>
              {orcidLoading ? tOrcid("redirecting") : tOrcid("verifyButton")}
            </button>
          </div>
        </form>

        <p className="text-sm text-ink-muted mt-4">
          {t("needHelp")}{" "}
          <Link href="/contact?category=accreditation" className="text-pevo-teal hover:underline">
            {t("contactUs")}
          </Link>
        </p>
      </div>
    </div>
  );
}
