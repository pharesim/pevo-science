"use client";

import { useTranslations } from "next-intl";
import type { ReviewInPaper } from "@pevo/contracts";
import AccreditationBadge from "./AccreditationBadge";
import RatingBar from "./RatingBar";
import VoteButtons from "./VoteButtons";
import MarkdownRenderer from "./MarkdownRenderer";

interface ReviewCardProps {
  review: ReviewInPaper;
}

import { formatDate } from "@/lib/format";

export default function ReviewCard({ review }: ReviewCardProps) {
  const t = useTranslations("review");
  const displayAuthor = review.is_anonymous ? t("anonymousReviewer") : `@${review.author}`;

  return (
    <div className="card">
      {/* Review header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{displayAuthor}</span>
            <AccreditationBadge isAccredited={review.is_accredited} />
            {review.is_anonymous && (
              <span className="text-xs px-2 py-0.5 rounded bg-parchment-warm text-ink-muted">
                {t("anonymous")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <time className="text-xs text-ink-muted" dateTime={review.created}>
              {formatDate(review.created)}
            </time>
            {review.reviewed_version && (
              <span className="text-xs text-ink-muted">
                &middot; {t("reviewedVersion", { version: String(review.reviewed_version) })}
              </span>
            )}
          </div>
        </div>
        <VoteButtons
          author={review.author}
          permlink={review.permlink}
          netVotes={review.net_votes}
        />
      </div>

      {/* Ratings */}
      <div className="space-y-2 mb-4 p-4 bg-parchment rounded-lg">
        <RatingBar label={t("methodology")} value={review.rating.methodology} />
        <RatingBar label={t("novelty")} value={review.rating.novelty} />
        <RatingBar label={t("clarity")} value={review.rating.clarity} />
        <RatingBar label={t("significance")} value={review.rating.significance} />
      </div>

      {/* Review body */}
      <MarkdownRenderer
        content={review.body}
        className="text-sm text-ink-light leading-relaxed prose prose-sm max-w-none"
      />
    </div>
  );
}
