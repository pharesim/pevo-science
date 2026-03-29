"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { PaperSortOption, PaperSourceFilter, PaperSummary, Discipline } from "@pevo/contracts";
import { fetchPapers, fetchDisciplines } from "@/lib/api";
import PaperCard from "@/components/PaperCard";
import PaperCardSkeleton from "@/components/skeletons/PaperCardSkeleton";
import PaperFilters from "@/components/PaperFilters";
import Pagination from "@/components/Pagination";
import LandingPage from "@/components/LandingPage";
import { useAuth } from "@/lib/auth";

const ITEMS_PER_PAGE = 10;

export default function HomePage() {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const { username, isConnected } = useAuth();

  const [discipline, setDiscipline] = useState("");
  const [sortBy, setSortBy] = useState<PaperSortOption>("date");
  const [sourceFilter, setSourceFilter] = useState<PaperSourceFilter | "">("");
  const [currentPage, setCurrentPage] = useState(1);

  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Fetch disciplines once on mount (only when connected)
  useEffect(() => {
    if (!isConnected) return;
    fetchDisciplines()
      .then((res) => setDisciplines(res.data))
      .catch(() => {
        // Non-critical; filter will just be empty
      });
  }, [isConnected]);

  // Fetch papers when filters/page change (only when connected)
  const loadPapers = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPapers({
        discipline: discipline || undefined,
        source: sourceFilter || undefined,
        sort: sortBy,
        page: currentPage,
        limit: ITEMS_PER_PAGE,
      });
      setPapers(res.data);
      if (res.meta) {
        setTotalPages(Math.ceil(res.meta.total / res.meta.limit));
      }
    } catch {
      setError(t("errorLoading"));
      setPapers([]);
    } finally {
      setLoading(false);
    }
  }, [discipline, sortBy, sourceFilter, currentPage, t, isConnected]);

  useEffect(() => {
    loadPapers();
  }, [loadPapers]);

  const handleDisciplineChange = (d: string) => {
    setDiscipline(d);
    setCurrentPage(1);
  };

  const handleSortChange = (s: PaperSortOption) => {
    setSortBy(s);
    setCurrentPage(1);
  };

  const handleSourceChange = (s: PaperSourceFilter | "") => {
    setSourceFilter(s);
    setCurrentPage(1);
  };

  // Show landing page for unauthenticated users
  if (!isConnected) {
    return <LandingPage />;
  }

  return (
    <div>
      {/* Hero Section */}
      <section className="relative bg-white border-b border-parchment-dark overflow-hidden">
        <div className="absolute inset-0 geo-pattern opacity-60" />
        <div className="container-narrow relative py-12 sm:py-16">
          <div className="flex flex-col sm:flex-row items-center gap-8">
            <div className="flex-1">
              <h1 className="text-4xl sm:text-5xl font-bold text-ink mb-4 leading-tight">
                {tc.rich("heroTitle", {
                  highlight: (chunks) => (
                    <span className="text-pevo-teal">{chunks}</span>
                  ),
                })}
              </h1>
              <p className="text-lg text-ink-muted mb-6 max-w-lg">
                {tc("heroDescription")}
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/publish" className="btn-primary no-underline">
                  {t("publishPaper")}
                </Link>
                <Link href="/about" className="btn-secondary no-underline">
                  {t("learnMore")}
                </Link>
              </div>
            </div>
            <div className="shrink-0 hidden md:block">
              <Image
                src="/images/pevo-logo.png"
                alt="PEvO"
                width={160}
                height={160}
                className="opacity-90"
                priority
              />
            </div>
          </div>
        </div>
      </section>

      {/* Paper Feed */}
      <div className="container-narrow py-8">
        {/* Section header */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-ink mb-1">{t("feedTitle")}</h2>
          <p className="text-sm text-ink-muted">
            {t("feedDescription")}
          </p>
        </div>

        {/* Filters */}
        <div className="mb-6">
          <PaperFilters
            disciplines={disciplines}
            selectedDiscipline={discipline}
            onDisciplineChange={handleDisciplineChange}
            sortBy={sortBy}
            onSortChange={handleSortChange}
            sourceFilter={sourceFilter}
            onSourceChange={handleSourceChange}
          />
        </div>

        {/* Loading state */}
        {loading && (
          <div className="space-y-4">
            {Array.from({ length: 3 }, (_, i) => (
              <PaperCardSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="card text-center py-12">
            <p className="text-ink-muted mb-4">{error}</p>
            <button className="btn-primary text-sm" onClick={loadPapers}>
              {t("retry")}
            </button>
          </div>
        )}

        {/* Results */}
        {!loading && !error && (
          <>
            {/* Results summary */}
            <div className="text-sm text-ink-muted mb-4">
              {t("papersFound", { count: papers.length })}
              {discipline && (
                <span>
                  {" "}
                  {t("inDiscipline", { discipline })}
                </span>
              )}
            </div>

            {/* Paper list */}
            {papers.length > 0 ? (
              <div className="space-y-4">
                {papers.map((paper) => (
                  <PaperCard key={`${paper.author}/${paper.permlink}`} paper={paper} />
                ))}
              </div>
            ) : (
              <div className="card text-center py-12">
                <p className="text-ink-muted">
                  {t("noPapersFound")}
                </p>
              </div>
            )}

            {/* Pagination */}
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setCurrentPage}
            />
          </>
        )}
      </div>
    </div>
  );
}
