"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import type { NotificationEvent } from "@pevo/contracts";
import { fetchNotifications } from "./api";
import { useAuth } from "./auth";

const BASE_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_CONSECUTIVE_FAILURES = 5;
const STORAGE_KEY_CURSOR = "pevo_notification_cursor";
const STORAGE_KEY_SEEN = "pevo_notification_seen_block";
const MAX_EVENTS = 200;

interface NotificationsState {
  events: NotificationEvent[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  pollingStopped: boolean;
  markAllRead: () => void;
  refresh: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsState>({
  events: [],
  unreadCount: 0,
  isLoading: false,
  error: null,
  pollingStopped: false,
  markAllRead: () => {},
  refresh: async () => {},
});

export function useNotifications(): NotificationsState {
  return useContext(NotificationsContext);
}

function getCursor(username: string): number {
  if (typeof window === "undefined") return 0;
  const val = localStorage.getItem(`${STORAGE_KEY_CURSOR}_${username}`);
  const n = val ? parseInt(val, 10) : 0;
  return (Number.isFinite(n) && n > 0 && n < 2_000_000_000) ? n : 0;
}

function setCursor(username: string, block: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${STORAGE_KEY_CURSOR}_${username}`, String(block));
}

function getSeenBlock(username: string): number {
  if (typeof window === "undefined") return 0;
  const val = localStorage.getItem(`${STORAGE_KEY_SEEN}_${username}`);
  const n = val ? parseInt(val, 10) : 0;
  return (Number.isFinite(n) && n > 0 && n < 2_000_000_000) ? n : 0;
}

function setSeenBlock(username: string, block: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${STORAGE_KEY_SEEN}_${username}`, String(block));
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { username, isConnected } = useAuth();
  const tNotif = useTranslations("notifications");
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [seenBlock, setSeenBlockState] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureCountRef = useRef(0);
  const currentIntervalRef = useRef(BASE_POLL_INTERVAL_MS);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    clearTimer();
    if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
      // Stop polling after too many consecutive failures
      setPollingStopped(true);
      return;
    }
    timerRef.current = setTimeout(() => {
      poll();
    }, currentIntervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- poll and clearTimer are stable via ref pattern
  }, []);

  const poll = useCallback(async () => {
    if (!username) return;

    const cursor = getCursor(username);

    try {
      setIsLoading(true);
      setError(null);
      setPollingStopped(false);

      const res = await fetchNotifications(cursor, 50);

      if (res.status === "ok" && res.data) {
        const batch = res.data;
        if (batch.events.length > 0) {
          setEvents((prev) => {
            const merged = [...batch.events, ...prev];
            // Deduplicate by block_num + type + actor combination
            const seen = new Set<string>();
            return merged.filter((e) => {
              const key = `${e.block_num}_${e.type}_${"actor" in e ? e.actor : "system"}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).slice(0, MAX_EVENTS);
          });
        }
        if (batch.latest_block > cursor) {
          setCursor(username, batch.latest_block);
        }
      }

      // Success: reset backoff
      failureCountRef.current = 0;
      currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
      scheduleNext();
    } catch {
      // Failure: exponential backoff
      failureCountRef.current += 1;
      if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setError(tNotif("pollingStoppedMessage"));
        setPollingStopped(true);
      } else {
        setError(tNotif("fetchFailed"));
        currentIntervalRef.current = Math.min(
          currentIntervalRef.current * 2,
          MAX_POLL_INTERVAL_MS,
        );
        scheduleNext();
      }
    } finally {
      setIsLoading(false);
    }
  }, [username, scheduleNext, tNotif]);

  // Initialize seen block from localStorage on connect
  useEffect(() => {
    if (username) {
      setSeenBlockState(getSeenBlock(username));
    } else {
      setEvents([]);
      setSeenBlockState(0);
    }
  }, [username]);

  // Start/stop polling
  useEffect(() => {
    if (!isConnected || !username) {
      clearTimer();
      failureCountRef.current = 0;
      currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
      setPollingStopped(false);
      return;
    }

    // Reset backoff state on fresh connect
    failureCountRef.current = 0;
    currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
    setPollingStopped(false);

    // Initial poll
    poll();

    return () => {
      clearTimer();
    };
  }, [isConnected, username, poll, clearTimer]);

  const unreadCount = events.filter((e) => e.block_num > seenBlock).length;

  const markAllRead = useCallback(() => {
    if (!username || events.length === 0) return;
    const maxBlock = Math.max(...events.map((e) => e.block_num));
    setSeenBlockState(maxBlock);
    setSeenBlock(username, maxBlock);
  }, [username, events]);

  const refresh = useCallback(async () => {
    // Reset backoff on manual refresh
    failureCountRef.current = 0;
    currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
    setPollingStopped(false);
    await poll();
  }, [poll]);

  return (
    <NotificationsContext.Provider
      value={{ events, unreadCount, isLoading, error, pollingStopped, markAllRead, refresh }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}
