import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Matches the dimensions of PaperCard: badge+date row, title, authors, abstract lines, keywords, metrics row. */
export default function PaperCardSkeleton() {
  return (
    <div className="card">
      {/* Header: discipline badge + date */}
      <div className="flex items-center justify-between mb-3">
        <SkeletonBlock className="h-5 w-20" />
        <SkeletonBlock className="h-4 w-28" />
      </div>

      {/* Title */}
      <SkeletonText className="h-6 w-4/5 mb-2" />

      {/* Authors */}
      <div className="flex items-center gap-2 mb-3">
        <SkeletonText className="h-4 w-40" />
        <SkeletonBlock className="h-4 w-4 rounded-full" />
      </div>

      {/* Abstract lines */}
      <div className="space-y-2 mb-4">
        <SkeletonText className="h-4 w-full" />
        <SkeletonText className="h-4 w-full" />
        <SkeletonText className="h-4 w-3/4" />
      </div>

      {/* Keywords */}
      <div className="flex gap-1.5 mb-4">
        <SkeletonBlock className="h-5 w-16 rounded-full" />
        <SkeletonBlock className="h-5 w-20 rounded-full" />
        <SkeletonBlock className="h-5 w-14 rounded-full" />
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-5 pt-3 border-t border-parchment-dark">
        <SkeletonBlock className="h-4 w-12" />
        <SkeletonBlock className="h-4 w-16" />
        <SkeletonBlock className="h-4 w-16" />
      </div>
    </div>
  );
}
