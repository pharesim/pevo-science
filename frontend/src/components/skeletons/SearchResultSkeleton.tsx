import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Single search result skeleton item. */
function SearchResultItemSkeleton() {
  return (
    <div className="card">
      {/* Type badge + date */}
      <div className="flex items-center gap-2 mb-2">
        <SkeletonBlock className="h-5 w-16" />
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="h-4 w-4 rounded-full" />
      </div>

      {/* Title */}
      <SkeletonText className="h-6 w-3/4 mb-1" />

      {/* Author */}
      <SkeletonText className="h-3 w-24 mb-2" />

      {/* Snippet lines */}
      <div className="space-y-2">
        <SkeletonText className="h-4 w-full" />
        <SkeletonText className="h-4 w-5/6" />
      </div>
    </div>
  );
}

/** Multiple search result skeleton items. */
export default function SearchResultSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, i) => (
        <SearchResultItemSkeleton key={i} />
      ))}
    </div>
  );
}
