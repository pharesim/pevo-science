"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DISCIPLINE_TAXONOMY } from "@pevo/contracts";
import type { BridgeLookupResult, BridgeCheckResult } from "@pevo/contracts";
import { useAuth } from "@/lib/auth";
import { fetchBridgeLookup, fetchBridgeCheck, registerBridgePaper, ApiRequestError } from "@/lib/api";
import { useToast } from "@/components/Toast";
import Link from "next/link";

type BridgeStep = "idle" | "registering" | "broadcasting" | "success" | "error";

export default function BridgePage() {
  const t = useTranslations("bridge");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { username, isConnected, connect } = useAuth();
  const { toast } = useToast();

  // Step 1: Identifier input
  const [identifier, setIdentifier] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState("");

  // Step 2: Preview
  const [lookup, setLookup] = useState<BridgeLookupResult | null>(null);
  const [check, setCheck] = useState<BridgeCheckResult | null>(null);

  // Step 3: Registration form
  const [discipline, setDiscipline] = useState("");
  const [disciplineSearch, setDisciplineSearch] = useState("");
  const [disciplineDropdownOpen, setDisciplineDropdownOpen] = useState(false);
  const [keywordsText, setKeywordsText] = useState("");
  const [language, setLanguage] = useState("");
  const disciplineRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<BridgeStep>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Filter taxonomy based on search
  const filteredTaxonomy = disciplineSearch.trim()
    ? DISCIPLINE_TAXONOMY.map((group) => ({
        ...group,
        subfields: group.subfields.filter((sf) =>
          sf.toLowerCase().includes(disciplineSearch.toLowerCase())
        ),
      })).filter((group) => group.subfields.length > 0)
    : DISCIPLINE_TAXONOMY;

  // Close discipline dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (disciplineRef.current && !disciplineRef.current.contains(e.target as Node)) {
        setDisciplineDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLookup = async () => {
    if (!identifier.trim()) return;
    setLookingUp(true);
    setLookupError("");
    setLookup(null);
    setCheck(null);
    try {
      const [lookupRes, checkRes] = await Promise.all([
        fetchBridgeLookup(identifier.trim()),
        fetchBridgeCheck(identifier.trim()),
      ]);
      setLookup(lookupRes.data);
      setCheck(checkRes.data);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : "";
      setLookupError(code === "INTERNAL_ERROR" ? t("lookupUnavailable") : t("lookupFailed"));
    } finally {
      setLookingUp(false);
    }
  };

  const handleRegister = async () => {
    if (!username || !discipline) return;

    try {
      // Call register endpoint — backend broadcasts via bridge account
      setStep("registering");
      const keywords = keywordsText
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const res = await registerBridgePaper(
        {
          identifier: identifier.trim(),
          discipline,
          keywords: keywords.length > 0 ? keywords : undefined,
          language: language.trim() || undefined,
        },
      );

      // 3. Success — backend already broadcast
      setStep("success");
      toast(t("stepSuccess"), "success");
      setTimeout(() => {
        router.push(`/paper/${res.data.author}/${res.data.permlink}`);
      }, 1500);
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : "Registration failed");
    }
  };

  const isDuplicate = check?.exists === true;
  const canRegister = lookup && !isDuplicate && discipline && step === "idle";

  // Wallet not connected
  if (!isConnected) {
    return (
      <div className="container-narrow py-8">
        <h1 className="text-3xl font-bold text-ink font-serif mb-2">{t("title")}</h1>
        <p className="text-ink-muted mb-6">{t("description")}</p>
        <div className="card text-center py-12">
          <p className="text-ink-muted mb-4">{t("walletHint")}</p>
          <button className="btn-primary" onClick={connect}>
            {tCommon("connectWallet")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink font-serif mb-2">{t("title")}</h1>
      <p className="text-ink-muted mb-6">{t("description")}</p>

      {/* Step 1: Identifier input */}
      <div className="card mb-6">
        <label htmlFor="bridge-id" className="block text-sm font-semibold text-ink mb-2">
          {t("identifierLabel")}
        </label>
        <div className="flex gap-3">
          <input
            id="bridge-id"
            type="text"
            className="select-control flex-1"
            placeholder={t("identifierPlaceholder")}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            disabled={lookingUp}
          />
          <button
            className="btn-primary text-sm whitespace-nowrap"
            onClick={handleLookup}
            disabled={lookingUp || !identifier.trim()}
          >
            {lookingUp ? t("lookingUp") : t("lookupButton")}
          </button>
        </div>
        {lookupError && (
          <p className="text-sm text-pevo-crimson mt-2">{lookupError}</p>
        )}
      </div>

      {/* Step 2: Preview */}
      {lookup && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold text-ink mb-4">{t("previewTitle")}</h2>

          <h3 className="text-base font-semibold text-ink mb-2">{lookup.title}</h3>

          <div className="text-sm text-ink-light mb-3">
            <span className="font-medium text-ink-muted">{t("authors")}:</span>{" "}
            {lookup.authors.map((a) => a.name).join(", ")}
          </div>

          <div className="text-sm text-ink-muted mb-3 line-clamp-4">
            <span className="font-medium">{t("abstract")}:</span>{" "}
            {lookup.abstract}
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-ink-muted mb-3">
            <span>
              <span className="font-medium">{t("published")}:</span>{" "}
              {new Date(lookup.published_date).toLocaleDateString()}
            </span>
            <span>
              <span className="font-medium">{t("source")}:</span>{" "}
              <a
                href={lookup.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pevo-teal hover:underline"
              >
                {lookup.source_name}
              </a>
            </span>
            {lookup.pdf_url && (
              <a
                href={lookup.pdf_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pevo-teal hover:underline"
              >
                {t("pdfLink")}
              </a>
            )}
          </div>

          {/* Duplicate warning */}
          {isDuplicate && check && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 mt-4">
              <p className="text-sm font-medium text-amber-800 mb-1">{t("duplicateWarning")}</p>
              <Link
                href={`/paper/${check.author}/${check.permlink}`}
                className="text-sm text-pevo-teal hover:underline"
              >
                {t("viewExisting")}
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Registration form */}
      {lookup && !isDuplicate && (
        <div className="card">
          <h2 className="text-lg font-semibold text-ink mb-4">{t("registerTitle")}</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            {/* Discipline picker */}
            <div className="relative" ref={disciplineRef}>
              <label htmlFor="bridge-discipline" className="block text-sm font-semibold text-ink mb-2">
                {t("disciplineLabel")}
              </label>
              <input
                id="bridge-discipline"
                type="text"
                className="select-control"
                placeholder={t("disciplinePlaceholder")}
                value={disciplineDropdownOpen ? disciplineSearch : discipline || disciplineSearch}
                onChange={(e) => {
                  setDisciplineSearch(e.target.value);
                  setDiscipline("");
                  setDisciplineDropdownOpen(true);
                }}
                onFocus={() => setDisciplineDropdownOpen(true)}
                autoComplete="off"
                required
              />
              {discipline && !disciplineDropdownOpen && (
                <button
                  type="button"
                  className="absolute right-2 top-9 text-ink-muted hover:text-ink"
                  onClick={() => { setDiscipline(""); setDisciplineSearch(""); }}
                  aria-label={t("clearDiscipline")}
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
              {disciplineDropdownOpen && (
                <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-parchment-dark bg-parchment shadow-md">
                  {filteredTaxonomy.length === 0 ? (
                    <div className="px-4 py-2 text-sm text-ink-muted">{t("noDisciplineMatch")}</div>
                  ) : (
                    filteredTaxonomy.map((group) => (
                      <div key={group.field}>
                        <div className="px-4 py-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide bg-parchment-warm">
                          {group.field}
                        </div>
                        {group.subfields.map((sf) => (
                          <button
                            key={sf}
                            type="button"
                            className="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors"
                            onClick={() => {
                              setDiscipline(sf);
                              setDisciplineSearch(sf);
                              setDisciplineDropdownOpen(false);
                            }}
                          >
                            {sf}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Keywords */}
            <div>
              <label htmlFor="bridge-keywords" className="block text-sm font-semibold text-ink mb-2">
                {t("keywordsLabel")}
              </label>
              <input
                id="bridge-keywords"
                type="text"
                className="select-control"
                placeholder={t("keywordsPlaceholder")}
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
              />
            </div>
          </div>

          {/* Language */}
          <div className="mb-6">
            <label htmlFor="bridge-language" className="block text-sm font-semibold text-ink mb-2">
              {t("languageLabel")}
            </label>
            <input
              id="bridge-language"
              type="text"
              className="select-control max-w-xs"
              placeholder={t("languagePlaceholder")}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            />
          </div>

          {/* Status / Submit */}
          {step === "idle" && (
            <button
              className="btn-primary"
              onClick={handleRegister}
              disabled={!canRegister}
            >
              {t("registerButton")}
            </button>
          )}

          {step === "registering" && (
            <p className="text-sm text-ink-muted">{t("stepRegistering")}</p>
          )}
          {step === "broadcasting" && (
            <p className="text-sm text-ink-muted">{t("stepBroadcasting")}</p>
          )}
          {step === "success" && (
            <p className="text-sm text-pevo-green font-medium">{t("stepSuccess")}</p>
          )}
          {step === "error" && (
            <div>
              <p className="text-sm text-pevo-crimson mb-2">{errorMessage}</p>
              <button className="btn-secondary text-sm" onClick={() => setStep("idle")}>
                {t("tryAgain")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
