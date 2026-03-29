"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { postComment } from "@/lib/keychain";

interface CommentComposerProps {
  parentAuthor: string;
  parentPermlink: string;
  onCommentPosted: () => void;
  onCancel?: () => void;
  placeholder?: string;
  compact?: boolean;
}

function generatePermlink(parentPermlink: string): string {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `re-${parentPermlink.slice(0, 40)}-${timestamp}-${rand}`;
}

export default function CommentComposer({
  parentAuthor,
  parentPermlink,
  onCommentPosted,
  onCancel,
  placeholder,
  compact = false,
}: CommentComposerProps) {
  const t = useTranslations("comments");
  const { username, isConnected } = useAuth();
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isConnected) {
    return (
      <div className={`${compact ? "p-3" : "card"} text-center`}>
        <p className="text-sm text-ink-muted">
          {t("connectToComment")}
        </p>
      </div>
    );
  }

  const handleSubmit = async () => {
    const trimmed = body.trim();
    if (!trimmed || !username) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const permlink = generatePermlink(parentPermlink);
      await postComment(username, permlink, parentAuthor, parentPermlink, trimmed);
      setBody("");
      onCommentPosted();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("postFailed");
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={compact ? "" : "card"}>
      <textarea
        className="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-pevo-teal focus:outline-none focus:ring-1 focus:ring-pevo-teal resize-y"
        rows={compact ? 2 : 3}
        placeholder={placeholder ?? t("writeComment")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={isSubmitting}
      />
      {error && (
        <p className="text-xs text-pevo-crimson mt-1">{error}</p>
      )}
      <div className="flex items-center justify-end gap-2 mt-2">
        {onCancel && (
          <button
            className="btn-secondary text-xs"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {t("cancel")}
          </button>
        )}
        <button
          className="btn-primary text-xs"
          onClick={handleSubmit}
          disabled={isSubmitting || !body.trim()}
        >
          {isSubmitting ? t("posting") : t("postComment")}
        </button>
      </div>
    </div>
  );
}
