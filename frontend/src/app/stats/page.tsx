"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { PlatformStats } from "@pevo/contracts";
import { fetchPlatformStats } from "@/lib/api";
import StatCardSkeleton from "@/components/skeletons/StatCardSkeleton";

interface StatCardProps {
  label: string;
  value: number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="card text-center">
      <div className="text-4xl font-bold text-ink font-serif">
        {value.toLocaleString()}
      </div>
      <div className="text-sm text-ink-muted mt-2">{label}</div>
    </div>
  );
}

export default function StatsPage() {
  const t = useTranslations("stats");
  const tCommon = useTranslations("common");
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const STAT_CONFIG: { key: keyof PlatformStats; label: string }[] = [
    { key: "total_papers", label: t("totalPapers") },
    { key: "total_reviews", label: t("totalReviews") },
    { key: "total_accredited_researchers", label: t("accreditedResearchers") },
    { key: "total_citations", label: t("totalCitations") },
    { key: "active_disciplines", label: t("activeDisciplines") },
    { key: "total_bridge_papers", label: t("totalBridgePapers") },
    { key: "papers_last_30_days", label: t("papersLast30") },
    { key: "reviews_last_30_days", label: t("reviewsLast30") },
  ];

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPlatformStats();
      setStats(res.data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("loadFailed");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  if (loading) {
    return (
      <div className="container-narrow py-8">
        <h1 className="text-3xl font-bold text-ink font-serif mb-2">
          {t("title")}
        </h1>
        <p className="text-ink-muted mb-6">
          {t("description")}
        </p>
        <StatCardSkeleton count={7} />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="container-narrow py-8">
        <div className="card text-center py-12">
          <p className="text-ink-muted mb-4">
            {error ?? t("loadFailed")}
          </p>
          <button className="btn-primary" onClick={loadStats}>
            {tCommon("retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink font-serif mb-2">
        {t("title")}
      </h1>
      <p className="text-ink-muted mb-6">
        {t("description")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {STAT_CONFIG.map(({ key, label }) => (
          <StatCard key={key} label={label} value={stats[key]} />
        ))}
      </div>
    </div>
  );
}
