"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { DiscussionComment } from "@pevo/contracts";
import { fetchPaperComments } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import AccreditationBadge from "./AccreditationBadge";
import VoteButtons from "./VoteButtons";
import CommentComposer from "./CommentComposer";
import MarkdownRenderer from "./MarkdownRenderer";

interface ThreadedCommentsProps {
  paperAuthor: string;
  paperPermlink: string;
}

import { formatDateShort as formatDate } from "@/lib/format";

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function countComments(comments: DiscussionComment[]): number {
  let count = 0;
  for (const c of comments) {
    count += 1 + countComments(c.replies);
  }
  return count;
}

// ─── Single comment node ─────────────────────────────────────

interface CommentNodeProps {
  comment: DiscussionComment;
  depth: number;
  onReplyPosted: () => void;
}

function CommentNode({ comment, depth, onReplyPosted }: CommentNodeProps) {
  const t = useTranslations("comments");
  const { isConnected } = useAuth();
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={depth > 0 ? "border-l-2 border-parchment-dark pl-2 sm:pl-4" : ""}>
      {/* Comment header */}
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <button
          className="text-ink-muted hover:text-ink font-mono text-xs"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? t("expand") : t("collapse")}
        >
          [{collapsed ? "+" : "\u2013"}]
        </button>
        <Link
          href={`/profile/${comment.author}`}
          className="font-medium text-ink no-underline hover:text-pevo-teal"
        >
          @{comment.author}
        </Link>
        <AccreditationBadge isAccredited={comment.is_accredited} />
        <time dateTime={comment.created} title={formatDate(comment.created)}>
          {formatTimeAgo(comment.created)}
        </time>
      </div>

      {!collapsed && (
        <>
          {/* Comment body */}
          <MarkdownRenderer
            content={comment.body}
            className="mt-1 text-sm text-ink-light leading-relaxed prose prose-sm max-w-none"
          />

          {/* Actions */}
          <div className="flex items-center gap-3 mt-1.5">
            <VoteButtons
              author={comment.author}
              permlink={comment.permlink}
              netVotes={comment.net_votes}
            />
            {isConnected && (
              <button
                className="text-xs text-ink-muted hover:text-pevo-teal transition-colors"
                onClick={() => setShowReplyForm(!showReplyForm)}
              >
                {t("reply")}
              </button>
            )}
          </div>

          {/* Reply form */}
          {showReplyForm && (
            <div className="mt-2">
              <CommentComposer
                parentAuthor={comment.author}
                parentPermlink={comment.permlink}
                onCommentPosted={() => {
                  setShowReplyForm(false);
                  onReplyPosted();
                }}
                onCancel={() => setShowReplyForm(false)}
                placeholder={t("replyTo", { author: comment.author })}
                compact
              />
            </div>
          )}

          {/* Nested replies */}
          {comment.replies.length > 0 && (
            <div className="mt-3 space-y-3">
              {comment.replies.map((reply) => (
                <CommentNode
                  key={`${reply.author}/${reply.permlink}`}
                  comment={reply}
                  depth={depth + 1}
                  onReplyPosted={onReplyPosted}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────

export default function ThreadedComments({ paperAuthor, paperPermlink }: ThreadedCommentsProps) {
  const t = useTranslations("comments");
  const [comments, setComments] = useState<DiscussionComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const loadComments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPaperComments(paperAuthor, paperPermlink);
      setComments(res.data);
      setTotalCount(countComments(res.data));
    } catch {
      setError(t("error"));
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [paperAuthor, paperPermlink, t]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const handleNewComment = () => {
    loadComments();
  };

  return (
    <section className="mt-8">
      <h2 className="text-section-title text-ink font-serif mb-4">
        {totalCount > 0 ? t("titleWithCount", { count: totalCount }) : t("title")}
      </h2>

      {/* Top-level composer */}
      <div className="mb-6">
        <CommentComposer
          parentAuthor={paperAuthor}
          parentPermlink={paperPermlink}
          onCommentPosted={handleNewComment}
          placeholder={t("startDiscussion")}
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="card text-center py-6">
          <p className="text-sm text-ink-muted">{t("loading")}</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="card text-center py-6">
          <p className="text-sm text-ink-muted">{error}</p>
        </div>
      )}

      {/* Comments tree */}
      {!loading && !error && comments.length > 0 && (
        <div className="space-y-4">
          {comments.map((comment) => (
            <div key={`${comment.author}/${comment.permlink}`} className="card">
              <CommentNode
                comment={comment}
                depth={0}
                onReplyPosted={handleNewComment}
              />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && comments.length === 0 && (
        <div className="card text-center py-6">
          <p className="text-sm text-ink-muted">
            {t("noComments")}
          </p>
        </div>
      )}
    </section>
  );
}
