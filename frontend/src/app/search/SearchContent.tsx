"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { SearchResult, Discipline, PaperSourceFilter } from "@pevo/contracts";
import { searchPapers, fetchDisciplines } from "@/lib/api";
import DOMPurify from "dompurify";
import AccreditationBadge from "@/components/AccreditationBadge";
import Pagination from "@/components/Pagination";
import SearchResultSkeleton from "@/components/skeletons/SearchResultSkeleton";

import { formatDate } from "@/lib/format";

export default function SearchContent() {
  const t = useTranslations("search");
  const tFilters = useTranslations("filters");
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState<"all" | "paper" | "review">("all");
  const [sourceFilter, setSourceFilter] = useState<PaperSourceFilter | "">("");
  const [disciplineFilter, setDisciplineFilter] = useState("");
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    fetchDisciplines()
      .then((res) => setDisciplines(res.data))
      .catch(() => {});
  }, []);

  const doSearch = useCallback(
    async (q: string, page: number) => {
      if (!q.trim()) return;
      setLoading(true);
      setError(null);
      setHasSearched(true);
      try {
        const res = await searchPapers({
          q: q.trim(),
          type: typeFilter === "all" ? undefined : typeFilter,
          discipline: disciplineFilter || undefined,
          source: sourceFilter || undefined,
          page,
          limit: 20,
        });
        setResults(res.data);
        if (res.meta) {
          setTotalPages(Math.ceil(res.meta.total / res.meta.limit));
        }
      } catch {
        setError(t("searchFailed"));
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [typeFilter, sourceFilter, disciplineFilter, t]
  );

  // Auto-search if query param is present
  useEffect(() => {
    if (initialQuery) {
      doSearch(initialQuery, 1);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCurrentPage(1);
    router.push(`/search?q=${encodeURIComponent(query)}`);
    doSearch(query, 1);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    doSearch(query, page);
  };

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink mb-2">{t("title")}</h1>
      <p className="text-ink-muted mb-6">
        {t("description")}
      </p>

      {/* Search form */}
      <form onSubmit={handleSubmit} role="search" className="mb-6">
        <div className="flex flex-col sm:flex-row gap-2">
          <label htmlFor="search-query" className="sr-only">{t("title")}</label>
          <input
            id="search-query"
            type="search"
            className="select-control flex-1 text-base"
            placeholder={t("placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full sm:w-auto shrink-0" disabled={loading}>
            {loading ? t("searching") : t("searchButton")}
          </button>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-3 mt-3">
          <div>
            <label htmlFor="type-filter" className="block text-xs font-medium text-ink-muted mb-1">
              {t("typeLabel")}
            </label>
            <select
              id="type-filter"
              className="select-control text-sm"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as "all" | "paper" | "review")}
            >
              <option value="all">{t("typeAll")}</option>
              <option value="paper">{t("typePapers")}</option>
              <option value="review">{t("typeReviews")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="source-filter" className="block text-xs font-medium text-ink-muted mb-1">
              {tFilters("source")}
            </label>
            <select
              id="source-filter"
              className="select-control text-sm"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as PaperSourceFilter | "")}
            >
              <option value="">{tFilters("allSources")}</option>
              <option value="native">{tFilters("nativePapers")}</option>
              <option value="bridge">{tFilters("preprints")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="discipline-filter" className="block text-xs font-medium text-ink-muted mb-1">
              {tFilters("discipline")}
            </label>
            <select
              id="discipline-filter"
              className="select-control text-sm capitalize"
              value={disciplineFilter}
              onChange={(e) => setDisciplineFilter(e.target.value)}
            >
              <option value="">{tFilters("allDisciplines")}</option>
              {disciplines.map((d) => (
                <option key={d.name} value={d.name} className="capitalize">
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </form>

      {/* Loading */}
      {loading && <SearchResultSkeleton count={4} />}

      {/* Error */}
      {!loading && error && (
        <div className="card text-center py-12">
          <p className="text-ink-muted">{error}</p>
        </div>
      )}

      {/* Results */}
      {!loading && !error && hasSearched && (
        <>
          <div className="text-sm text-ink-muted mb-4">
            {t("resultsFound", { count: results.length })}
          </div>

          {results.length > 0 ? (
            <div className="space-y-4">
              {results.map((result) => (
                <article key={`${result.author}/${result.permlink}`} className="card hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-2 text-xs text-ink-muted mb-2">
                    <span className="badge-discipline capitalize">{result.type}</span>
                    <time dateTime={result.created}>{formatDate(result.created)}</time>
                    <AccreditationBadge isAccredited={result.is_accredited} />
                  </div>
                  <h2 className="text-lg font-serif font-semibold mb-1">
                    <Link
                      href={`/paper/${result.author}/${result.permlink}`}
                      className="text-ink hover:text-pevo-teal no-underline"
                    >
                      {result.title}
                    </Link>
                  </h2>
                  <p className="text-xs text-ink-muted mb-2">@{result.author}</p>
                  {/* Snippet with highlighted matches */}
                  <div
                    className="text-sm text-ink-light leading-relaxed [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:rounded"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.snippet, { ALLOWED_TAGS: ['mark', 'b', 'em'] }) }}
                  />
                </article>
              ))}
            </div>
          ) : (
            <div className="card text-center py-12">
              <p className="text-ink-muted">{t("noResults")}</p>
            </div>
          )}

          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      )}

      {/* Initial state */}
      {!loading && !error && !hasSearched && (
        <div className="card text-center py-12">
          <p className="text-ink-muted">{t("initialPrompt")}</p>
        </div>
      )}
    </div>
  );
}
