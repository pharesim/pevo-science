"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth";
import { vote } from "@/lib/keychain";
import { useToast } from "@/components/Toast";

interface VoteButtonsProps {
  author: string;
  permlink: string;
  netVotes: number;
}

export default function VoteButtons({ author, permlink, netVotes }: VoteButtonsProps) {
  const t = useTranslations("vote");
  const { username, isConnected, connect } = useAuth();
  const { toast } = useToast();
  const [voteState, setVoteState] = useState<"none" | "up" | "down">("none");
  const [displayVotes, setDisplayVotes] = useState(netVotes);
  const [isVoting, setIsVoting] = useState(false);

  const handleVote = async (weight: number) => {
    if (!isConnected) {
      try {
        await connect();
      } catch {
        return;
      }
      return;
    }

    if (!username) return;

    const direction = weight > 0 ? "up" : "down";
    if (voteState === direction) return;

    setIsVoting(true);
    try {
      await vote(username, author, permlink, weight);
      const previousState = voteState;
      setVoteState(direction);
      let delta = 0;
      if (previousState === "none") delta = direction === "up" ? 1 : -1;
      else if (previousState === "up" && direction === "down") delta = -2;
      else if (previousState === "down" && direction === "up") delta = 2;
      setDisplayVotes((v) => v + delta);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("voteFailed");
      toast(message, "error");
    } finally {
      setIsVoting(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        className={`p-1 rounded transition-colors disabled:opacity-50 ${
          voteState === "up"
            ? "text-pevo-green"
            : "text-ink-muted hover:text-pevo-green"
        }`}
        onClick={() => handleVote(10000)}
        disabled={isVoting}
        title={t("upvote")}
        aria-label={t("upvote")}
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3l-7 7h4v7h6v-7h4L10 3z" />
        </svg>
      </button>
      <span className="text-sm font-medium text-ink min-w-[1.5rem] text-center">
        {displayVotes}
      </span>
      <button
        className={`p-1 rounded transition-colors disabled:opacity-50 ${
          voteState === "down"
            ? "text-pevo-crimson"
            : "text-ink-muted hover:text-pevo-crimson"
        }`}
        onClick={() => handleVote(-10000)}
        disabled={isVoting}
        title={t("downvote")}
        aria-label={t("downvote")}
      >
        <svg className="h-4 w-4 rotate-180" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3l-7 7h4v7h6v-7h4L10 3z" />
        </svg>
      </button>
    </div>
  );
}
