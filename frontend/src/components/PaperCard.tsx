"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { PaperSummary } from "@pevo/contracts";
import AccreditationBadge from "./AccreditationBadge";
import VoteButtons from "./VoteButtons";

interface PaperCardProps {
  paper: PaperSummary;
}

import { formatDate } from "@/lib/format";

function truncateAbstract(text: string, maxLength: number = 280): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "...";
}

export default function PaperCard({ paper }: PaperCardProps) {
  const t = useTranslations("paperCard");
  const authorNames = paper.authors.map((a) => a.name).join(", ");

  return (
    <article className="card hover:shadow-sm transition-shadow">
      {/* Header: discipline + source badge + date */}
      <div className="flex items-center justify-between text-xs text-ink-muted mb-3">
        <div className="flex items-center gap-2">
          <span className="badge-discipline capitalize">{paper.discipline}</span>
          {paper.source_type !== "native" && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20">
              {paper.source_type === "arxiv" ? "arXiv" : "DOI"}
            </span>
          )}
        </div>
        <time dateTime={paper.created}>{formatDate(paper.created)}</time>
      </div>

      {/* Title */}
      <h2 className="text-paper-title leading-snug mb-2">
        <Link
          href={`/paper/${paper.author}/${paper.permlink}`}
          className="text-ink hover:text-pevo-teal no-underline"
        >
          {paper.title}
        </Link>
      </h2>

      {/* Authors */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3">
        <p className="text-sm text-ink-light">{authorNames}</p>
        <AccreditationBadge isAccredited={paper.is_accredited} />
      </div>

      {/* Abstract preview */}
      <p className="text-sm text-ink-muted leading-relaxed mb-4">
        {truncateAbstract(paper.abstract)}
      </p>

      {/* Keywords */}
      {paper.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {paper.keywords.map((kw) => (
            <span
              key={kw}
              className="text-xs px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted"
            >
              {kw}
            </span>
          ))}
        </div>
      )}

      {/* Metrics */}
      <div className="flex items-center gap-5 text-xs text-ink-muted pt-3 border-t border-parchment-dark">
        <VoteButtons
          author={paper.author}
          permlink={paper.permlink}
          netVotes={paper.net_votes}
        />
        <span className="flex items-center gap-1" title="Reviews">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z"
              clipRule="evenodd"
            />
          </svg>
          {t("reviews", { count: paper.review_count })}
        </span>
        <span className="flex items-center gap-1" title="Citations">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" />
          </svg>
          {t("citations", { count: paper.citation_count })}
        </span>
        {paper.ipfs_cid && (
          <span className="flex items-center gap-1 ml-auto rtl:ml-0 rtl:mr-auto" title="PDF available on IPFS">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                clipRule="evenodd"
              />
            </svg>
            {t("pdf")}
          </span>
        )}
      </div>
    </article>
  );
}
