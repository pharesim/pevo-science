"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DISCIPLINE_TAXONOMY } from "@pevo/contracts";
import { APP_TAG, APP_ID } from "@/lib/app-config";
import { useAuth } from "@/lib/auth";
import { uploadToIpfs } from "@/lib/api";
import { publishPaper } from "@/lib/keychain";
import { sha256, sha256File, slugify } from "@/lib/crypto";
import LazyTiptapEditor from "@/components/LazyTiptapEditor";
import { useToast } from "@/components/Toast";

const DRAFT_KEY = "pevo-draft-publish";

interface PublishDraft {
  title: string;
  abstract: string;
  body: string;
  discipline: string;
  keywordsText: string;
  coAuthors: CoAuthor[];
  authorName: string;
  authorAffiliation: string;
  authorOrcid: string;
  savedAt: number;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

interface CoAuthor {
  name: string;
  hive: string;
  orcid: string;
  affiliation: string;
}

type PublishStep = "idle" | "hashing" | "uploading" | "broadcasting" | "success" | "error";

const ABSTRACT_MAX_CHARS = 2000;
const TX_WARN_BYTES = 55_000;
const TX_HARD_BYTES = 60_000;

/** Build the Hive post body from abstract + full text. */
function composePostBody(abstract: string, fullText: string): string {
  if (!fullText) return abstract;
  return abstract + "\n\n---\n\n" + fullText;
}

/** Estimate byte size of the transaction payload (body + metadata + title + overhead). */
function estimateTxBytes(title: string, postBody: string, metadataJson: string): number {
  const encoder = new TextEncoder();
  return encoder.encode(title).length + encoder.encode(postBody).length + encoder.encode(metadataJson).length + 500;
}

export default function PublishPage() {
  const t = useTranslations("publish");
  const tCommon = useTranslations("common");
  const tFilters = useTranslations("filters");
  const router = useRouter();
  const { username, isConnected, isAccredited, accreditation, connect } = useAuth();
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [body, setBody] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([]);
  const [authorName, setAuthorName] = useState(accreditation?.name ?? "");
  const [authorAffiliation, setAuthorAffiliation] = useState(accreditation?.institution ?? "");
  const [authorOrcid, setAuthorOrcid] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [disciplineSearch, setDisciplineSearch] = useState("");
  const [disciplineDropdownOpen, setDisciplineDropdownOpen] = useState(false);

  const disciplineRef = useRef<HTMLDivElement>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const initialLoadDone = useRef(false);

  // Restore draft on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft: PublishDraft = JSON.parse(raw);
        if (draft && typeof draft.title === "string") {
          setTitle(draft.title);
          setAbstract(draft.abstract);
          setBody(draft.body);
          setDiscipline(draft.discipline);
          setKeywordsText(draft.keywordsText);
          setCoAuthors(draft.coAuthors || []);
          if (draft.authorName) setAuthorName(draft.authorName);
          if (draft.authorAffiliation) setAuthorAffiliation(draft.authorAffiliation);
          if (draft.authorOrcid) setAuthorOrcid(draft.authorOrcid);
          setDraftSavedAt(draft.savedAt);
          setDraftRestored(true);
        }
      }
    } catch {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    }
    initialLoadDone.current = true;
  }, []);

  // Auto-save draft on change (debounced 2s)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const hasContent = title.trim() || abstract.trim() || body.trim();
    if (!hasContent) {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      return;
    }
    const timeout = setTimeout(() => {
      try {
        const draft: PublishDraft = { title, abstract, body, discipline, keywordsText, coAuthors, authorName, authorAffiliation, authorOrcid, savedAt: Date.now() };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch { /* ignore — best effort */ }
    }, 2000);
    return () => clearTimeout(timeout);
  }, [title, abstract, body, discipline, keywordsText, coAuthors, authorName, authorAffiliation, authorOrcid]);

  const discardDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    setTitle("");
    setAbstract("");
    setBody("");
    setDiscipline("");
    setKeywordsText("");
    setCoAuthors([]);
    setAuthorName(accreditation?.name ?? "");
    setAuthorAffiliation(accreditation?.institution ?? "");
    setAuthorOrcid("");
    setDraftRestored(false);
    setDraftSavedAt(null);
  };

  const [step, setStep] = useState<PublishStep>("idle");
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

  const addCoAuthor = () => {
    setCoAuthors([...coAuthors, { name: "", hive: "", orcid: "", affiliation: "" }]);
  };

  const updateCoAuthor = (index: number, field: keyof CoAuthor, value: string) => {
    const updated = [...coAuthors];
    updated[index] = { ...updated[index], [field]: value };
    setCoAuthors(updated);
  };

  const removeCoAuthor = (index: number) => {
    setCoAuthors(coAuthors.filter((_, i) => i !== index));
  };

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : tCommon("connectionFailed");
      toast(message, "error");
    }
  };

  // Compose the Hive post body from abstract + full text
  const postBody = useMemo(() => composePostBody(abstract, body), [abstract, body]);

  // Estimate transaction size for warnings
  const txEstimate = useMemo(() => {
    // Rough metadata estimate — real metadata is built at submit time but this is close enough
    const metaEstimate = JSON.stringify({
      app: APP_ID,
      tags: [APP_TAG, "science", discipline, ...keywordsText.split(",").map((k) => k.trim()).filter(Boolean)],
      [APP_TAG]: { type: "paper", version: 1, authors: coAuthors, discipline, keywords: [] },
    });
    return estimateTxBytes(title, postBody, metaEstimate);
  }, [title, postBody, discipline, keywordsText, coAuthors]);

  const txWarn = txEstimate >= TX_WARN_BYTES;
  const txBlock = txEstimate >= TX_HARD_BYTES;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !isConnected || !authorName.trim()) return;

    if (txBlock) {
      toast(t("txTooLarge"), "error");
      return;
    }

    setStep("hashing");
    setErrorMessage("");

    try {
      const abstractHash = await sha256(abstract);
      const contentHash = await sha256(title + "\n" + postBody);

      let ipfsCid: string | null = null;
      let ipfsFilename: string | null = null;
      let documentHash: string | null = null;

      if (pdfFile) {
        setStep("hashing");
        documentHash = await sha256File(pdfFile);

        setStep("uploading");
        const uploadRes = await uploadToIpfs(pdfFile);
        ipfsCid = uploadRes.data.cid;
        ipfsFilename = uploadRes.data.filename;
      }

      const permlink = slugify(title) + "-" + Date.now().toString(36);

      const keywords = keywordsText
        .split(",")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      const authors = [
        { name: authorName, hive: username, orcid: authorOrcid, affiliation: authorAffiliation },
        ...coAuthors.filter((ca) => ca.name && ca.hive),
      ];

      const jsonMetadata = {
        app: APP_ID,
        tags: [APP_TAG, "science", discipline, ...keywords].filter(Boolean),
        [APP_TAG]: {
          type: "paper" as const,
          version: 1,
          authors,
          discipline,
          keywords,
          ipfs_cid: ipfsCid,
          ipfs_filename: ipfsFilename,
          language: "en",
          abstract_hash: abstractHash,
          document_hash: documentHash,
          content_hash: contentHash,
        },
      };

      setStep("broadcasting");
      await publishPaper(username, permlink, title, postBody, jsonMetadata);

      setStep("success");
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      setTimeout(() => {
        router.push(`/paper/${username}/${permlink}`);
      }, 1500);
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : "Publishing failed");
    }
  };

  const stepMessages: Record<PublishStep, string> = {
    idle: "",
    hashing: t("stepHashing"),
    uploading: t("stepUploading"),
    broadcasting: t("stepBroadcasting"),
    success: t("stepSuccess"),
    error: errorMessage || tCommon("error"),
  };

  const isSubmitting = step !== "idle" && step !== "success" && step !== "error";

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink mb-2">{t("title")}</h1>
      <p className="text-ink-muted mb-8">
        {t("description")}
      </p>

      {draftRestored && draftSavedAt && (
        <div className="card bg-pevo-teal-light border-pevo-teal/30 mb-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink">
              Draft restored from {relativeTime(draftSavedAt)}.
            </p>
            <button
              type="button"
              className="text-sm font-medium text-pevo-teal hover:text-pevo-teal-dark"
              onClick={discardDraft}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {!isConnected && (
        <div className="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
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

      {isConnected && !isAccredited && (
        <div className="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-medium text-ink text-sm">{t("accreditationRequired")}</p>
              <Link href="/accreditation" className="btn-primary text-xs mt-2 inline-block">
                {t("getAccredited")}
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Progress indicator */}
      {step !== "idle" && (
        <div
          className={`card mb-6 ${
            step === "success"
              ? "bg-pevo-green-light border-pevo-green/30"
              : step === "error"
              ? "bg-pevo-crimson-light border-pevo-crimson/30"
              : "bg-pevo-teal-light border-pevo-teal/30"
          }`}
        >
          <p className="text-sm font-medium">
            {stepMessages[step]}
          </p>
          {step === "error" && (
            <button
              className="btn-secondary text-xs mt-2"
              onClick={() => setStep("idle")}
            >
              {t("tryAgain")}
            </button>
          )}
        </div>
      )}

      <form onSubmit={isAccredited ? handleSubmit : (e) => e.preventDefault()} className="space-y-6">
        {/* Title */}
        <div className="card">
          <label htmlFor="paper-title" className="block text-sm font-semibold text-ink mb-2">
            {t("paperTitle")}
          </label>
          <input
            id="paper-title"
            type="text"
            className="select-control text-base"
            placeholder={t("titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>

        {/* Abstract */}
        <div className="card">
          <label className="block text-sm font-semibold text-ink mb-2">
            {t("abstract")}
          </label>
          <LazyTiptapEditor
            variant="abstract"
            content={abstract}
            onChange={setAbstract}
            maxLength={ABSTRACT_MAX_CHARS}
            placeholder={t("abstractPlaceholder")}
          />
          <p className="text-xs text-ink-muted mt-1">{t("abstractHint")}</p>
        </div>

        {/* Discipline + Keywords */}
        <div className="card">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="relative" ref={disciplineRef}>
              <label htmlFor="discipline" className="block text-sm font-semibold text-ink mb-2">
                {tFilters("discipline")}
              </label>
              <input
                id="discipline"
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
            <div>
              <label htmlFor="keywords" className="block text-sm font-semibold text-ink mb-2">
                {t("keywords")}
              </label>
              <input
                id="keywords"
                type="text"
                className="select-control"
                placeholder={t("keywordsPlaceholder")}
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
              />
              <p className="text-xs text-ink-muted mt-1">{t("keywordsHint")}</p>
            </div>
          </div>
        </div>

        {/* Primary author */}
        <div className="card">
          <label className="block text-sm font-semibold text-ink mb-3">{t("yourInfo")}</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="author-name" className="block text-xs font-medium text-ink-muted mb-1">
                {t("yourName")} *
              </label>
              <input
                id="author-name"
                type="text"
                className="select-control"
                placeholder={t("fullName")}
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="author-affiliation" className="block text-xs font-medium text-ink-muted mb-1">
                {t("affiliation")}
              </label>
              <input
                id="author-affiliation"
                type="text"
                className="select-control"
                placeholder={t("affiliation")}
                value={authorAffiliation}
                onChange={(e) => setAuthorAffiliation(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="author-orcid" className="block text-xs font-medium text-ink-muted mb-1">
                {t("orcidOptional")}
              </label>
              <input
                id="author-orcid"
                type="text"
                className="select-control"
                placeholder="0000-0001-2345-6789"
                value={authorOrcid}
                onChange={(e) => setAuthorOrcid(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Co-authors */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-semibold text-ink">{t("coAuthors")}</label>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={addCoAuthor}
            >
              {t("addCoAuthor")}
            </button>
          </div>
          {coAuthors.length === 0 && (
            <p className="text-xs text-ink-muted">{t("noCoAuthors")}</p>
          )}
          {coAuthors.map((ca, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 p-3 bg-parchment rounded-lg">
              <input
                type="text"
                className="select-control text-xs"
                placeholder={t("fullName")}
                aria-label={`${t("fullName")} (co-author ${i + 1})`}
                value={ca.name}
                onChange={(e) => updateCoAuthor(i, "name", e.target.value)}
              />
              <input
                type="text"
                className="select-control text-xs"
                placeholder={t("hiveUsername")}
                aria-label={`${t("hiveUsername")} (co-author ${i + 1})`}
                value={ca.hive}
                onChange={(e) => updateCoAuthor(i, "hive", e.target.value)}
              />
              <input
                type="text"
                className="select-control text-xs"
                placeholder={t("orcidOptional")}
                aria-label={`${t("orcidOptional")} (co-author ${i + 1})`}
                value={ca.orcid}
                onChange={(e) => updateCoAuthor(i, "orcid", e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  className="select-control text-xs flex-1"
                  placeholder={t("affiliation")}
                  aria-label={`${t("affiliation")} (co-author ${i + 1})`}
                  value={ca.affiliation}
                  onChange={(e) => updateCoAuthor(i, "affiliation", e.target.value)}
                />
                <button
                  type="button"
                  className="text-ink-muted hover:text-ink shrink-0 px-1"
                  onClick={() => removeCoAuthor(i)}
                  aria-label={t("removeCoAuthor")}
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Paper body */}
        <div className="card">
          <label htmlFor="paper-body" className="text-sm font-semibold text-ink mb-2 block">
            {t("paperContent")}
          </label>
          <LazyTiptapEditor content={body} onChange={setBody} username={username ?? undefined} remainingChars={TX_HARD_BYTES - txEstimate} />
          <p className="text-xs text-ink-muted mt-2">
            {t("markdownHint")}
          </p>
        </div>

        {/* PDF Upload */}
        <div className="card">
          <label htmlFor="pdf-upload" className="text-sm font-semibold text-ink mb-2 block">
            {t("pdfUpload")}
          </label>
          <p className="text-xs text-ink-muted mb-3">
            {t("pdfHint")}
          </p>
          <input
            id="pdf-upload"
            type="file"
            accept=".pdf"
            className="block text-sm text-ink-muted file:mr-4 file:py-2 file:px-4 file:rounded-md file:border file:border-parchment-dark file:text-sm file:font-medium file:bg-white file:text-ink hover:file:bg-parchment-warm file:cursor-pointer file:transition-colors"
            onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
          />
          {pdfFile && (
            <p className="text-xs text-pevo-green mt-2">
              {t("pdfSelected", {
                name: pdfFile.name,
                size: (pdfFile.size / 1024 / 1024).toFixed(2),
              })}
            </p>
          )}
        </div>

        {/* Transaction size warning */}
        {txWarn && (
          <div className={`card ${txBlock ? "bg-pevo-crimson-light border-pevo-crimson/30" : "bg-pevo-gold-light border-pevo-gold/30"}`}>
            <p className={`text-sm font-medium ${txBlock ? "text-pevo-crimson" : "text-pevo-gold-dark"}`}>
              {txBlock ? t("txTooLarge") : t("txWarnLarge")}
            </p>
            <p className="text-xs text-ink-muted mt-1">
              {t("txSizeHint", { current: Math.round(txEstimate / 1024), max: Math.round(TX_HARD_BYTES / 1024) })}
            </p>
          </div>
        )}

        {/* Submit */}
        <div className="flex flex-col-reverse sm:flex-row items-start sm:items-center justify-between gap-3">
          <p className="text-xs text-ink-muted">
            {t("permanentNotice")}
          </p>
          {isAccredited ? (
            <button
              type="submit"
              className="btn-primary w-full sm:w-auto shrink-0"
              disabled={isSubmitting || txBlock}
            >
              {isSubmitting ? t("publishing") : t("publishButton")}
            </button>
          ) : !isConnected ? (
            <Link href="/getting-started" className="btn-primary w-full sm:w-auto shrink-0 text-center no-underline">
              {t("publishButton")}
            </Link>
          ) : (
            <Link href="/accreditation" className="btn-primary w-full sm:w-auto shrink-0 text-center no-underline">
              {t("getAccredited")}
            </Link>
          )}
        </div>
      </form>

      <p className="text-sm text-ink-muted mt-4">
        {t("needHelp")}{" "}
        <Link href="/contact?category=keychain" className="text-pevo-teal hover:underline">
          {t("contactUs")}
        </Link>
      </p>
    </div>
  );
}
