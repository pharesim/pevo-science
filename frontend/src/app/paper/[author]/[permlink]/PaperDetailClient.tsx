"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { PaperDetail } from "@pevo/contracts";
import { fetchPaper, fetchPaperEnrichment } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCitationExport, useRetraction, usePaperDoi, useBridgeSync } from "./hooks";
import AccreditationBadge from "@/components/AccreditationBadge";
import ReviewCard from "@/components/ReviewCard";
import RatingBar from "@/components/RatingBar";
import VoteButtons from "@/components/VoteButtons";
import ThreadedComments from "@/components/ThreadedComments";
import MarkdownRenderer from "@/components/LazyMarkdownRenderer";
import VersionSelector from "@/components/VersionSelector";
import PaperDetailSkeleton from "@/components/skeletons/PaperDetailSkeleton";
import { useToast } from "@/components/Toast";

interface PaperDetailClientProps {
  author: string;
  permlink: string;
  initialData?: PaperDetail | null;
}

import { formatDate } from "@/lib/format";

function averageRating(reviews: { rating: { methodology: number; novelty: number; clarity: number; significance: number } }[]) {
  if (reviews.length === 0) return null;
  const sum = { methodology: 0, novelty: 0, clarity: 0, significance: 0 };
  for (const r of reviews) {
    sum.methodology += r.rating.methodology;
    sum.novelty += r.rating.novelty;
    sum.clarity += r.rating.clarity;
    sum.significance += r.rating.significance;
  }
  const n = reviews.length;
  return {
    methodology: Math.round((sum.methodology / n) * 10) / 10,
    novelty: Math.round((sum.novelty / n) * 10) / 10,
    clarity: Math.round((sum.clarity / n) * 10) / 10,
    significance: Math.round((sum.significance / n) * 10) / 10,
  };
}

export default function PaperDetailClient({ author, permlink, initialData }: PaperDetailClientProps) {
  const t = useTranslations("paperDetail");
  const tReview = useTranslations("review");
  const tRetraction = useTranslations("retraction");
  const tBridge = useTranslations("bridge");
  const tCitation = useTranslations("citation");
  const tDoi = useTranslations("doi");
  const { isConnected, username } = useAuth();
  const { toast } = useToast();
  const [paper, setPaper] = useState<PaperDetail | null>(initialData ?? null);
  const [loading, setLoading] = useState(initialData === undefined);
  const [enrichmentLoading, setEnrichmentLoading] = useState(true);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [error, setError] = useState<string | null>(initialData === undefined ? null : initialData === null ? "Not found" : null);

  const setPaperStable = useCallback((p: PaperDetail) => setPaper(p), []);
  const { citeOpen, setCiteOpen, citeLoading, citeRef, handleCitationExport } = useCitationExport(paper);
  const { retractDialogOpen, setRetractDialogOpen, retractReason, setRetractReason, retractLoading, handleRetract } = useRetraction(author, permlink, username, setPaperStable);
  const { doiData, doiLoading, handleAssignDoi } = usePaperDoi(paper, username);
  const { syncLoading, handleSync } = useBridgeSync(author, permlink, username, setPaperStable);

  useEffect(() => {
    // Skip client-side fetch if we got data from the server
    if (initialData !== undefined) return;

    setLoading(true);
    setError(null);
    fetchPaper(author, permlink)
      .then((res) => setPaper(res.data))
      .catch((err) => {
        const message = err instanceof Error ? err.message : t("errorLoadingTitle");
        setError(message);
      })
      .finally(() => setLoading(false));
  }, [author, permlink, initialData]);

  // Lazy-load accreditation-dependent enrichment (votes, reviews, citations)
  useEffect(() => {
    if (!paper) return;
    setEnrichmentLoading(true);
    fetchPaperEnrichment(author, permlink)
      .then((res) => {
        setPaper((prev) => prev ? { ...prev, ...res.data } : prev);
      })
      .catch(() => { /* enrichment failure is non-critical */ })
      .finally(() => setEnrichmentLoading(false));
  }, [author, permlink, !!paper]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <PaperDetailSkeleton />;
  }

  if (error || !paper) {
    return (
      <div className="container-narrow py-8">
        <div className="card text-center py-12">
          <h1 className="text-2xl font-bold text-ink mb-2">
            {error === "Not found" ? t("notFoundTitle") : t("errorLoadingTitle")}
          </h1>
          <p className="text-ink-muted mb-4">
            {error ?? t("notFoundDescription", { author, permlink })}
          </p>
          <Link href="/" className="btn-primary">
            {t("backToPapers")}
          </Link>
        </div>
      </div>
    );
  }

  const avg = averageRating(paper.reviews);
  const pevoMeta = paper.json_metadata?.pevo as Record<string, unknown> | undefined;
  const isBridgePaper = pevoMeta?.type === "bridge_paper";
  const bridgeSource = isBridgePaper
    ? (pevoMeta?.source as { type?: string; url?: string; doi?: string; arxiv_id?: string; source_name?: string } | undefined)
    : undefined;
  const ipfsGateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
  const ipfsGatewayUrl = paper.ipfs_cid
    ? `${ipfsGateway.replace(/\/+$/, '')}/${paper.ipfs_cid}`
    : null;

  return (
    <div className="container-narrow py-8">
      {/* Back link */}
      <Link href="/" className="text-sm text-pevo-teal hover:text-pevo-teal-hover no-underline">
        &larr; {t("backToPapers")}
      </Link>

      {/* Retraction banner */}
      {paper.is_retracted && (
        <div className="mt-4 rounded-lg border-2 border-pevo-crimson bg-pevo-crimson-light px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <svg className="h-5 w-5 text-pevo-crimson shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <span className="text-pevo-crimson-dark font-bold text-lg uppercase tracking-wide">
              {tRetraction("banner")}
            </span>
          </div>
          {paper.retraction_reason && (
            <p className="text-sm text-pevo-crimson-dark mt-1">
              {tRetraction("reason")}: {paper.retraction_reason}
            </p>
          )}
          {paper.retraction_timestamp && (
            <p className="text-xs text-pevo-crimson-dark/70 mt-1">
              {tRetraction("date")}: {formatDate(paper.retraction_timestamp)}
            </p>
          )}
        </div>
      )}

      {/* Version selector */}
      {paper.versions.length > 1 && (
        <div className="mt-4">
          <VersionSelector
            versions={paper.versions}
            currentVersion={paper.versions[paper.versions.length - 1]?.version_number ?? 1}
          />
        </div>
      )}

      {/* Bridge source info panel */}
      {isBridgePaper && bridgeSource && (
        <div className="mt-4 rounded-lg border border-pevo-teal/30 bg-pevo-teal-light/50 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink">
            <span className="inline-flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20">
                {bridgeSource.type === "arxiv" ? "arXiv" : "DOI"}
              </span>
              {tBridge("sourcePanel", { source: bridgeSource.source_name || bridgeSource.type || "" })}
            </span>
            {bridgeSource.url ? (
              <span className="ml-2">
                <a
                  href={bridgeSource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-pevo-teal hover:underline text-sm"
                >
                  {tBridge("viewSource", { source: bridgeSource.source_name || bridgeSource.type || "" })}
                </a>
              </span>
            ) : null}
          </div>
          {/* Sync button for registerer */}
          {isConnected && username === paper.author && (
            <button
              className="btn-secondary text-sm"
              onClick={handleSync}
              disabled={syncLoading}
            >
              {syncLoading ? tBridge("syncing") : tBridge("syncButton")}
            </button>
          )}
        </div>
      )}

      {/* Paper header */}
      <article className="card mt-4">
        <div className="flex items-center gap-2 text-xs text-ink-muted mb-3">
          <span className="badge-discipline capitalize">{paper.discipline}</span>
          <time dateTime={paper.created}>{formatDate(paper.created)}</time>
          {paper.last_update !== paper.created && (
            <span className="text-ink-muted">
              ({t("updated", { date: formatDate(paper.last_update) })})
            </span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
          <h1 className="text-paper-title text-ink flex-1">{paper.title}</h1>

          <div className="flex items-center gap-2 shrink-0">
            {/* Citation export dropdown */}
            <div className="relative" ref={citeRef}>
              <button
                type="button"
                className="btn-secondary text-sm flex items-center gap-1.5"
                onClick={() => setCiteOpen((prev) => !prev)}
                disabled={citeLoading}
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" />
                </svg>
                {tCitation("citeButton")}
              </button>
              {citeOpen && (
                <div className="absolute right-0 rtl:right-auto rtl:left-0 mt-1 w-44 rounded-lg border border-parchment-dark bg-parchment shadow-md z-10">
                  <button
                    type="button"
                    className="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-t-lg"
                    onClick={() => handleCitationExport("apa")}
                  >
                    {tCitation("apaFormat")}
                  </button>
                  <button
                    type="button"
                    className="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors"
                    onClick={() => handleCitationExport("bibtex")}
                  >
                    {tCitation("bibtexFormat")}
                  </button>
                  <button
                    type="button"
                    className="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-b-lg"
                    onClick={() => handleCitationExport("ris")}
                  >
                    {tCitation("risFormat")}
                  </button>
                </div>
              )}
            </div>

            {/* Retract button (author only) */}
            {isConnected && username === paper.author && !paper.is_retracted && (
              <button
                type="button"
                className="btn-secondary text-sm text-pevo-crimson border-pevo-crimson/30 hover:bg-pevo-crimson-light"
                onClick={() => setRetractDialogOpen(true)}
              >
                {tRetraction("retractButton")}
              </button>
            )}
          </div>
        </div>

        {/* Retraction confirmation dialog */}
        {retractDialogOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="card max-w-md w-full mx-4">
              <h3 className="text-lg font-bold text-pevo-crimson mb-2">
                {tRetraction("confirmTitle")}
              </h3>
              <p className="text-sm text-ink-muted mb-4">
                {tRetraction("confirmDescription")}
              </p>
              <div className="mb-4">
                <label htmlFor="retract-reason" className="block text-sm font-medium text-ink mb-1">
                  {tRetraction("reasonLabel")}
                </label>
                <textarea
                  id="retract-reason"
                  className="select-control w-full"
                  rows={3}
                  placeholder={tRetraction("reasonPlaceholder")}
                  value={retractReason}
                  onChange={(e) => setRetractReason(e.target.value)}
                  required
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  onClick={() => { setRetractDialogOpen(false); setRetractReason(""); }}
                  disabled={retractLoading}
                >
                  {tRetraction("cancel")}
                </button>
                <button
                  type="button"
                  className="btn-primary text-sm bg-pevo-crimson hover:bg-pevo-crimson-dark"
                  onClick={handleRetract}
                  disabled={retractLoading || !retractReason.trim()}
                >
                  {retractLoading ? tRetraction("retracting") : tRetraction("confirmRetract")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Authors */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
          {paper.authors.map((a, i) =>
            a.hive ? (
              <Link
                key={a.hive}
                href={`/profile/${a.hive}`}
                className="text-sm no-underline hover:underline"
              >
                <span className="text-ink font-medium">{a.name}</span>
                {a.affiliation && (
                  <span className="text-ink-muted ml-1">({a.affiliation})</span>
                )}
              </Link>
            ) : (
              <span key={`coauthor-${i}`} className="text-sm">
                <span className="text-ink font-medium">{a.name}</span>
                {a.affiliation && (
                  <span className="text-ink-muted ml-1">({a.affiliation})</span>
                )}
              </span>
            )
          )}
          {enrichmentLoading ? (
            <span className="inline-block h-4 w-16 rounded bg-parchment-dark/40 animate-pulse" />
          ) : (
            <AccreditationBadge isAccredited={paper.is_accredited} />
          )}
        </div>

        {/* Keywords */}
        <div className="flex flex-wrap gap-1.5 mb-6">
          {paper.keywords.map((kw) => (
            <span
              key={kw}
              className="text-xs px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted"
            >
              {kw}
            </span>
          ))}
        </div>

        {/* Metrics bar */}
        <div className="flex flex-wrap items-center gap-5 text-sm text-ink-muted pb-6 border-b border-parchment-dark">
          {isConnected && (
            <VoteButtons
              author={paper.author}
              permlink={paper.permlink}
              netVotes={paper.net_votes}
            />
          )}
          {!isConnected && (
            <span title="Votes" className="flex items-center gap-1">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 3l-7 7h4v7h6v-7h4L10 3z" />
              </svg>
              {enrichmentLoading ? (
                <span className="inline-block h-3 w-6 rounded bg-parchment-dark/40 animate-pulse" />
              ) : (
                t("votes", { count: paper.net_votes })
              )}
            </span>
          )}
          <span title="Reviews" className="flex items-center gap-1">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z"
                clipRule="evenodd"
              />
            </svg>
            {enrichmentLoading ? (
              <span className="inline-block h-3 w-6 rounded bg-parchment-dark/40 animate-pulse" />
            ) : (
              t("reviews", { count: paper.reviews.length })
            )}
          </span>
          <span title="Citations" className="flex items-center gap-1">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" />
            </svg>
            {enrichmentLoading ? (
              <span className="inline-block h-3 w-6 rounded bg-parchment-dark/40 animate-pulse" />
            ) : (
              t("citations", { count: paper.citation_count })
            )}
          </span>
          {ipfsGatewayUrl && (
            <a
              href={ipfsGatewayUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 ml-auto rtl:ml-0 rtl:mr-auto text-pevo-teal no-underline hover:text-pevo-teal-hover"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                  clipRule="evenodd"
                />
              </svg>
              {t("downloadPdf")}
            </a>
          )}
        </div>

        {/* DOI section */}
        {doiData && doiData.status === "registered" && doiData.doi && (
          <div className="flex items-center gap-2 mt-4 text-sm">
            <span className="font-medium text-ink">{tDoi("label")}:</span>
            <a
              href={doiData.doi_url ?? `https://doi.org/${doiData.doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-pevo-teal hover:text-pevo-teal-hover no-underline"
            >
              {doiData.doi}
            </a>
            <button
              type="button"
              className="text-ink-muted hover:text-ink transition-colors"
              title={tDoi("copyDoi")}
              onClick={async () => {
                await navigator.clipboard.writeText(doiData.doi!);
                toast(tDoi("doiCopied"), "success");
              }}
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
                <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM15 11h2a1 1 0 110 2h-2v-2z" />
              </svg>
            </button>
          </div>
        )}

        {/* Assign DOI button (author only, no DOI yet) */}
        {isConnected && username === paper.author && !paper.is_retracted &&
          doiData && doiData.status === "unregistered" && (
          <div className="mt-4">
            <button
              type="button"
              className="btn-secondary text-sm flex items-center gap-1.5"
              onClick={handleAssignDoi}
              disabled={doiLoading}
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16 8 8 0 000-16zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.56-.5-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.56.5.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.497-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clipRule="evenodd" />
              </svg>
              {doiLoading ? tDoi("assigning") : tDoi("assignButton")}
            </button>
          </div>
        )}

        {/* Abstract — extracted from body markdown */}
        {(() => {
          // Extract ## Abstract section, or fall back to text before first --- or ## heading (legacy posts)
          const explicit = paper.body.match(/##\s*Abstract\s*\n+([\s\S]*?)(?=\n##\s|\n---|\n\*\*\*|$)/i);
          const leading = !explicit ? paper.body.match(/^([^#\n][\s\S]*?)(?=\n---|\n##\s|\n\*\*\*)/) : null;
          const abs = (explicit?.[1] || leading?.[1] || "").trim();
          if (!abs) return null;
          return (
            <section className="mt-8">
              <h2 className="text-xl font-bold text-ink-dark mb-3 font-serif">
                {t("abstractTitle")}
              </h2>
              <div className="border-l-4 border-pevo-teal/30 bg-parchment-warm/50 rounded-r-lg px-5 py-4">
                <p className="text-[0.95rem] leading-relaxed text-ink-light">
                  {abs}
                </p>
              </div>
            </section>
          );
        })()}

        {/* Paper body — collapsed by default */}
        <section className="mt-8">
          <button
            onClick={() => setBodyExpanded(!bodyExpanded)}
            className="flex items-center gap-2 text-xl font-bold text-ink-dark font-serif hover:text-pevo-teal transition-colors"
            aria-expanded={bodyExpanded}
          >
            <svg
              className={`h-4 w-4 shrink-0 transition-transform ${bodyExpanded ? "rotate-90" : ""}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
            {t("paperBody")}
          </button>
          {bodyExpanded && (
            <MarkdownRenderer
              content={paper.body}
              className="mt-4 prose max-w-none text-[0.95rem]"
            />
          )}
        </section>
      </article>

      {/* Citations */}
      {paper.citations.length > 0 && (
        <section className="mt-8">
          <h2 className="text-section-title text-ink font-serif mb-4">
            {t("referencesTitle")}
          </h2>
          <div className="space-y-2">
            {paper.citations.map((c) => (
              <Link
                key={`${c.author}/${c.permlink}`}
                href={`/paper/${c.author}/${c.permlink}`}
                className="card block no-underline hover:shadow-sm transition-shadow"
              >
                <p className="text-sm font-medium text-ink">{c.title}</p>
                <p className="text-xs text-ink-muted mt-1">@{c.author}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Reviews section */}
      <section className="mt-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-section-title text-ink font-serif">
            {enrichmentLoading ? t("peerReviewsTitle", { count: 0 }) : t("peerReviewsTitle", { count: paper.reviews.length })}
          </h2>
          {username !== paper.author && (
            <Link
              href={`/review/${paper.author}/${paper.permlink}`}
              className="btn-primary text-sm w-full sm:w-auto text-center shrink-0"
            >
              {t("writeReview")}
            </Link>
          )}
        </div>

        {enrichmentLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-4 w-1/3 rounded bg-parchment-dark/40 mb-3" />
                <div className="h-3 w-full rounded bg-parchment-dark/30 mb-2" />
                <div className="h-3 w-2/3 rounded bg-parchment-dark/30" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Average ratings */}
            {avg && (
              <div className="card mb-6">
                <h3 className="text-sm font-semibold text-ink mb-3">
                  {t("averageRatings", { count: paper.reviews.length })}
                </h3>
                <div className="space-y-2">
                  <RatingBar label={tReview("methodology")} value={avg.methodology} />
                  <RatingBar label={tReview("novelty")} value={avg.novelty} />
                  <RatingBar label={tReview("clarity")} value={avg.clarity} />
                  <RatingBar label={tReview("significance")} value={avg.significance} />
                </div>
              </div>
            )}

            {/* Individual reviews */}
            <div className="space-y-4">
              {paper.reviews.map((review) => (
                <ReviewCard key={review.permlink} review={review} />
              ))}
            </div>

            {paper.reviews.length === 0 && (
              <div className="card text-center py-8">
                <p className="text-ink-muted mb-3">{t("noReviews")}</p>
                {username !== paper.author && (
                  <Link
                    href={`/review/${paper.author}/${paper.permlink}`}
                    className="btn-primary text-sm"
                  >
                    {t("writeReview")}
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Discussion threads */}
      <ThreadedComments paperAuthor={paper.author} paperPermlink={paper.permlink} />
    </div>
  );
}
