import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Single researcher card skeleton. */
function ResearcherCardItemSkeleton() {
  return (
    <div className="card">
      <div className="mb-2">
        <SkeletonText className="h-6 w-3/4 mb-1" />
        <SkeletonText className="h-4 w-24" />
      </div>
      <div className="space-y-1">
        <SkeletonText className="h-4 w-40" />
        <SkeletonText className="h-4 w-28" />
      </div>
      <div className="mt-3 pt-3 border-t border-parchment-dark flex items-center gap-2">
        <SkeletonBlock className="h-3 w-24" />
        <SkeletonBlock className="h-3 w-28" />
      </div>
    </div>
  );
}

/** Grid of researcher card skeletons. */
export default function ResearcherCardSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }, (_, i) => (
        <ResearcherCardItemSkeleton key={i} />
      ))}
    </div>
  );
}
