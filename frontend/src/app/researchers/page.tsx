"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { AccreditedResearcher } from "@pevo/contracts";
import { fetchAccreditations, fetchDisciplines } from "@/lib/api";
import Pagination from "@/components/Pagination";
import ResearcherCardSkeleton from "@/components/skeletons/ResearcherCardSkeleton";

const ITEMS_PER_PAGE = 12;

import { formatDate } from "@/lib/format";

export default function ResearchersPage() {
  const t = useTranslations("researchers");
  const tCommon = useTranslations("common");
  const [researchers, setResearchers] = useState<AccreditedResearcher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Filters
  const [fieldFilter, setFieldFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");

  // Disciplines for dropdown
  const [disciplines, setDisciplines] = useState<string[]>([]);

  const methodLabel = useCallback((method: string): string => {
    switch (method) {
      case "email":
        return t("emailVerification");
      case "orcid":
        return t("orcid");
      case "dao_vote":
        return t("daoVote");
      case "wot":
      case "web_of_trust":
        return t("webOfTrust");
      case "pgp":
        return t("pgpVerification");
      case "personal":
        return t("personalVerification");
      default:
        return method;
    }
  }, [t]);

  useEffect(() => {
    fetchDisciplines()
      .then((res) => setDisciplines(res.data.map((d) => d.name)))
      .catch(() => {});
  }, []);

  const loadResearchers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAccreditations({
        field: fieldFilter || undefined,
        institution: institutionFilter || undefined,
        page,
        limit: ITEMS_PER_PAGE,
      });
      setResearchers(res.data);
      if (res.meta) {
        setTotalPages(Math.ceil(res.meta.total / res.meta.limit) || 1);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("loadFailed");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [fieldFilter, institutionFilter, page]);

  useEffect(() => {
    loadResearchers();
  }, [loadResearchers]);

  const handleFieldChange = (value: string) => {
    setFieldFilter(value);
    setPage(1);
  };

  const handleInstitutionChange = (value: string) => {
    setInstitutionFilter(value);
    setPage(1);
  };

  return (
    <div className="container-narrow py-8">
      <h1 className="text-3xl font-bold text-ink font-serif mb-2">
        {t("title")}
      </h1>
      <p className="text-ink-muted mb-6">
        {t("description")}
      </p>

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label
              htmlFor="field-filter"
              className="block text-sm font-medium text-ink-light mb-1"
            >
              {t("fieldLabel")}
            </label>
            <select
              id="field-filter"
              className="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-pevo-teal"
              value={fieldFilter}
              onChange={(e) => handleFieldChange(e.target.value)}
            >
              <option value="">{t("allFields")}</option>
              {disciplines.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label
              htmlFor="institution-filter"
              className="block text-sm font-medium text-ink-light mb-1"
            >
              {t("institutionLabel")}
            </label>
            <input
              id="institution-filter"
              type="text"
              placeholder={t("institutionPlaceholder")}
              className="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-light focus:outline-none focus:ring-2 focus:ring-pevo-teal"
              value={institutionFilter}
              onChange={(e) => handleInstitutionChange(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <ResearcherCardSkeleton count={6} />
      ) : error ? (
        <div className="card text-center py-12">
          <p className="text-ink-muted mb-4">{error}</p>
          <button className="btn-primary" onClick={loadResearchers}>
            {tCommon("retry")}
          </button>
        </div>
      ) : researchers.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-ink-muted">
            {t("noResearchers")}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {researchers.map((r) => (
              <div key={r.username} className="card">
                <div className="mb-2">
                  <h2 className="text-lg font-bold text-ink font-serif">
                    {r.name}
                  </h2>
                  <Link
                    href={`/profile/${r.username}`}
                    className="text-sm text-pevo-teal hover:underline"
                  >
                    @{r.username}
                  </Link>
                </div>
                <div className="space-y-1 text-sm text-ink-light">
                  <p>{r.institution}</p>
                  <p className="capitalize">{r.field}</p>
                </div>
                <div className="mt-3 pt-3 border-t border-parchment-dark text-xs text-ink-muted">
                  <span>{methodLabel(r.method)}</span>
                  <span className="mx-1">&middot;</span>
                  <span>{formatDate(r.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>

          <Pagination
            currentPage={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
