"use client";

import { useRef, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NotificationEvent } from "@pevo/contracts";
import { useNotifications } from "@/lib/notifications";

function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function EventIcon({ type }: { type: NotificationEvent["type"] }) {
  const iconClass = "w-4 h-4 flex-shrink-0";
  switch (type) {
    case "new_review":
      return (
        <svg className={`${iconClass} text-pevo-teal`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
        </svg>
      );
    case "new_citation":
      return (
        <svg className={`${iconClass} text-pevo-green`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.07-9.07l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
        </svg>
      );
    case "new_vote":
      return (
        <svg className={`${iconClass} text-pevo-green`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904M14.25 9h2.25M5.904 18.75c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 01-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 10.203 4.167 9.75 5 9.75h1.053c.472 0 .745.556.5.96a8.958 8.958 0 00-1.302 4.665c0 1.194.232 2.333.654 3.375z" />
        </svg>
      );
    case "accreditation_update":
      return (
        <svg className={`${iconClass} text-pevo-crimson`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        </svg>
      );
    case "new_vouch":
      return (
        <svg className={`${iconClass} text-pevo-teal`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
      );
    case "new_reply":
      return (
        <svg className={`${iconClass} text-ink-muted`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
        </svg>
      );
  }
}

function useEventDescription() {
  const t = useTranslations("notifications");
  return (event: NotificationEvent): { text: string; href: string } => {
    switch (event.type) {
      case "new_review":
        return {
          text: t("newReview", { actor: event.actor, title: event.paper_title }),
          href: `/paper/${event.paper_author}/${event.paper_permlink}`,
        };
      case "new_citation":
        return {
          text: t("newCitation", { actor: event.actor, title: event.paper_title }),
          href: `/paper/${event.paper_author}/${event.paper_permlink}`,
        };
      case "new_vote":
        return {
          text: t("newVote", { actor: event.actor, targetType: event.target_type }),
          href: `/paper/${event.target_author}/${event.target_permlink}`,
        };
      case "accreditation_update":
        return {
          text: event.action === "accredit"
            ? t("accreditationGranted")
            : t("accreditationRevoked"),
          href: "/accreditation",
        };
      case "new_vouch":
        return {
          text: t("newVouch", { actor: event.actor, relationship: event.relationship }),
          href: `/profile/${event.actor}`,
        };
      case "new_reply":
        return {
          text: t("newReply", { actor: event.actor }),
          href: `/paper/${event.paper_author}/${event.paper_permlink}`,
        };
    }
  };
}

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function NotificationPanel({ open, onClose }: NotificationPanelProps) {
  const t = useTranslations("notifications");
  const { events, unreadCount, isLoading, error, pollingStopped, markAllRead, refresh } = useNotifications();
  const panelRef = useRef<HTMLDivElement>(null);
  const getEventDescription = useEventDescription();

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label={t("title")}
      className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-96 max-h-[28rem] overflow-hidden rounded-lg border border-parchment-dark bg-white shadow-lg z-50 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-parchment-dark">
        <h3 className="text-sm font-semibold text-ink">
          {t("title")}{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </h3>
        {unreadCount > 0 && (
          <button
            className="text-xs text-pevo-teal hover:text-pevo-teal-dark font-medium"
            onClick={markAllRead}
          >
            {t("markAllRead")}
          </button>
        )}
      </div>

      {/* Polling stopped banner */}
      {pollingStopped && (
        <div className="px-4 py-2 bg-pevo-crimson-light border-b border-pevo-crimson/20 flex items-center justify-between gap-2">
          <p className="text-xs text-pevo-crimson">{t("pollingStopped")}</p>
          <button
            className="text-xs font-medium text-pevo-teal hover:text-pevo-teal-dark shrink-0"
            onClick={refresh}
          >
            {t("retry")}
          </button>
        </div>
      )}

      {/* Body */}
      <div className="overflow-y-auto flex-1">
        {isLoading && events.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-muted">
            {t("loading")}
          </div>
        ) : error && events.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-pevo-crimson">
            {error}
          </div>
        ) : events.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-muted">
            {t("empty")}
          </div>
        ) : (
          <ul className="divide-y divide-parchment">
            {events.map((event, i) => {
              const { text, href } = getEventDescription(event);
              const isUnread = event.block_num > 0;
              return (
                <li key={`${event.block_num}-${event.type}-${i}`}>
                  <Link
                    href={href}
                    onClick={onClose}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-parchment transition-colors no-underline"
                  >
                    <div className="mt-0.5">
                      <EventIcon type={event.type} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-snug ${isUnread ? "text-ink" : "text-ink-light"}`}>
                        {text}
                      </p>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {timeAgo(event.timestamp)}
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
