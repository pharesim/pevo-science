"use client";

import { useTranslations } from "next-intl";
import type { Discipline, PaperSortOption, PaperSourceFilter } from "@pevo/contracts";

interface PaperFiltersProps {
  disciplines: Discipline[];
  selectedDiscipline: string;
  onDisciplineChange: (discipline: string) => void;
  sortBy: PaperSortOption;
  onSortChange: (sort: PaperSortOption) => void;
  sourceFilter?: PaperSourceFilter | "";
  onSourceChange?: (source: PaperSourceFilter | "") => void;
}

export default function PaperFilters({
  disciplines,
  selectedDiscipline,
  onDisciplineChange,
  sortBy,
  onSortChange,
  sourceFilter,
  onSourceChange,
}: PaperFiltersProps) {
  const t = useTranslations("filters");

  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
      {/* Discipline filter */}
      <div className="flex-1 sm:max-w-xs">
        <label
          htmlFor="discipline-filter"
          className="block text-xs font-medium text-ink-muted mb-1"
        >
          {t("discipline")}
        </label>
        <select
          id="discipline-filter"
          className="select-control capitalize"
          value={selectedDiscipline}
          onChange={(e) => onDisciplineChange(e.target.value)}
        >
          <option value="">{t("allDisciplines")}</option>
          {disciplines.map((d) => (
            <option key={d.name} value={d.name} className="capitalize">
              {d.name} ({d.paper_count})
            </option>
          ))}
        </select>
      </div>

      {/* Source filter */}
      {onSourceChange && (
        <div className="w-full sm:w-40">
          <label
            htmlFor="source-filter"
            className="block text-xs font-medium text-ink-muted mb-1"
          >
            {t("source")}
          </label>
          <select
            id="source-filter"
            className="select-control"
            value={sourceFilter ?? ""}
            onChange={(e) => onSourceChange(e.target.value as PaperSourceFilter | "")}
          >
            <option value="">{t("allSources")}</option>
            <option value="native">{t("nativePapers")}</option>
            <option value="bridge">{t("preprints")}</option>
          </select>
        </div>
      )}

      {/* Sort selector */}
      <div className="w-full sm:w-48">
        <label
          htmlFor="sort-selector"
          className="block text-xs font-medium text-ink-muted mb-1"
        >
          {t("sortBy")}
        </label>
        <select
          id="sort-selector"
          className="select-control"
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as PaperSortOption)}
        >
          <option value="date">{t("mostRecent")}</option>
          <option value="votes">{t("mostVotes")}</option>
          <option value="reputation">{t("authorReputation")}</option>
        </select>
      </div>
    </div>
  );
}
