"use client";

import { use, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { PaperDetail } from "@pevo/contracts";
import { APP_TAG, APP_ID } from "@/lib/app-config";
import { useAuth } from "@/lib/auth";
import { fetchPaper, submitAnonymousReview } from "@/lib/api";
import { postReview } from "@/lib/keychain";
import { slugify } from "@/lib/crypto";
import { useToast } from "@/components/Toast";

interface ReviewPageProps {
  params: Promise<{
    author: string;
    permlink: string;
  }>;
}

type RatingKey = "methodology" | "novelty" | "clarity" | "significance";

function StarRating({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="p-4 bg-parchment rounded-lg">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-sm font-bold text-ink">{value > 0 ? `${value}/5` : "--"}</span>
      </div>
      <p className="text-xs text-ink-muted mb-2">{description}</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            className={`p-2 rounded transition-colors ${
              star <= value
                ? "text-pevo-teal"
                : "text-parchment-dark hover:text-ink-muted"
            }`}
            aria-label={`Rate ${label} ${star} out of 5`}
          >
            <svg className="h-7 w-7 sm:h-6 sm:w-6" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

type SubmitStep = "idle" | "submitting" | "success" | "error";

export default function ReviewPage({ params }: ReviewPageProps) {
  const { author, permlink } = use(params);
  const t = useTranslations("review");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { username, isConnected, connect } = useAuth();
  const { toast } = useToast();

  const RATING_CONFIG: { key: RatingKey; label: string; description: string }[] = [
    { key: "methodology", label: t("methodology"), description: t("methodologyDesc") },
    { key: "novelty", label: t("novelty"), description: t("noveltyDesc") },
    { key: "clarity", label: t("clarity"), description: t("clarityDesc") },
    { key: "significance", label: t("significance"), description: t("significanceDesc") },
  ];

  const [ratings, setRatings] = useState<Record<RatingKey, number>>({
    methodology: 0,
    novelty: 0,
    clarity: 0,
    significance: 0,
  });
  const [reviewBody, setReviewBody] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const [paper, setPaper] = useState<PaperDetail | null>(null);
  const [loadingPaper, setLoadingPaper] = useState(true);

  const [step, setStep] = useState<SubmitStep>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    fetchPaper(author, permlink)
      .then((res) => setPaper(res.data))
      .catch(() => {})
      .finally(() => setLoadingPaper(false));
  }, [author, permlink]);

  const paperTitle = paper?.title ?? `${author}/${permlink}`;
  const allRated = Object.values(ratings).every((v) => v > 0);

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
    if (!username || !isConnected || !allRated) return;

    setStep("submitting");
    setErrorMessage("");

    try {
      if (isAnonymous) {
        const requestBody = {
          paper_author: author,
          paper_permlink: permlink,
          body: reviewBody,
          rating: ratings,
        };

        await submitAnonymousReview(requestBody);
      } else {
        const reviewPermlink = `re-${author}-${slugify(permlink)}-${Date.now().toString(36)}`;

        const paperVersion = paper?.versions?.[paper.versions.length - 1]?.version_number ?? 1;

        const jsonMetadata = {
          app: APP_ID,
          tags: [APP_TAG, "review"],
          [APP_TAG]: {
            type: "review" as const,
            version: 1,
            rating: ratings,
            is_anonymous: false,
            reviewer_attestation_id: null,
            reviewed_version: paperVersion,
          },
        };

        setStep("submitting");
        await postReview(
          username,
          reviewPermlink,
          author,
          permlink,
          reviewBody,
          jsonMetadata
        );
      }

      setStep("success");
      setTimeout(() => {
        router.push(`/paper/${author}/${permlink}`);
      }, 1500);
    } catch (err) {
      setStep("error");
      setErrorMessage(err instanceof Error ? err.message : t("submissionFailed"));
    }
  };

  const stepMessages: Record<SubmitStep, string> = {
    idle: "",
    submitting: isAnonymous ? t("stepSubmittingAnon") : t("stepSubmitting"),
    success: t("stepSuccess"),
    error: errorMessage || tCommon("error"),
  };

  const isSubmitting = step !== "idle" && step !== "success" && step !== "error";

  return (
    <div className="container-narrow py-8">
      <Link
        href={`/paper/${author}/${permlink}`}
        className="text-sm text-pevo-teal hover:text-pevo-teal-dark no-underline"
      >
        &larr; {t("backToPaper")}
      </Link>

      <h1 className="text-3xl font-bold text-ink mt-4 mb-2">{t("title")}</h1>
      <p className="text-ink-muted mb-2">
        {t("reviewing")}
      </p>
      {loadingPaper ? (
        <p className="text-sm text-ink-muted mb-8">{t("loadingPaper")}</p>
      ) : (
        <Link
          href={`/paper/${author}/${permlink}`}
          className="text-sm font-medium text-pevo-teal no-underline hover:underline mb-8 block"
        >
          {paperTitle}
        </Link>
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
          <p className="text-sm font-medium">{stepMessages[step]}</p>
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

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Structured ratings */}
        <div className="card">
          <h2 className="text-section-title text-ink font-serif mb-4">{t("ratingsTitle")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {RATING_CONFIG.map(({ key, label, description }) => (
              <StarRating
                key={key}
                label={label}
                description={description}
                value={ratings[key]}
                onChange={(v) => setRatings({ ...ratings, [key]: v })}
              />
            ))}
          </div>
        </div>

        {/* Review body */}
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="review-body" className="text-sm font-semibold text-ink">
              {t("writtenReview")}
            </label>
            <button
              type="button"
              className="text-xs text-pevo-teal hover:text-pevo-teal-dark"
              onClick={() => setShowPreview(!showPreview)}
            >
              {showPreview ? t("edit") : t("preview")}
            </button>
          </div>
          {showPreview ? (
            <div className="min-h-[200px] p-4 bg-parchment rounded-lg text-sm text-ink-light leading-relaxed whitespace-pre-line">
              {reviewBody || t("nothingToPreview")}
            </div>
          ) : (
            <textarea
              id="review-body"
              className="select-control font-mono text-sm min-h-[200px] resize-y"
              placeholder={t("reviewPlaceholder")}
              value={reviewBody}
              onChange={(e) => setReviewBody(e.target.value)}
              required
            />
          )}
        </div>

        {/* Anonymous option */}
        <div className="card">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-parchment-dark text-pevo-teal focus:ring-accent"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
            />
            <div>
              <span className="text-sm font-medium text-ink">{t("anonymousLabel")}</span>
              <p className="text-xs text-ink-muted mt-1">
                {t("anonymousDescription")}
              </p>
            </div>
          </label>
        </div>

        {/* Submit */}
        <div className="flex flex-col-reverse sm:flex-row items-start sm:items-center justify-between gap-3">
          <p className="text-xs text-ink-muted">
            {t("permanentNotice")}
          </p>
          <button
            type="submit"
            className="btn-primary w-full sm:w-auto shrink-0"
            disabled={!isConnected || !allRated || isSubmitting}
          >
            {isSubmitting ? t("submitting") : t("submitButton")}
          </button>
        </div>
      </form>
    </div>
  );
}
