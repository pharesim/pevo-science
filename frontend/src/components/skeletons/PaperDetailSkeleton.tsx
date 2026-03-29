import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Skeleton for the paper detail page: title, metadata, body, reviews section. */
export default function PaperDetailSkeleton() {
  return (
    <div className="container-narrow py-8">
      {/* Back link */}
      <SkeletonBlock className="h-4 w-28 mb-4" />

      {/* Paper card */}
      <div className="card mt-4">
        {/* Discipline + date */}
        <div className="flex items-center gap-2 mb-3">
          <SkeletonBlock className="h-5 w-20" />
          <SkeletonBlock className="h-4 w-32" />
        </div>

        {/* Title */}
        <SkeletonText className="h-8 w-3/4 mb-4" />

        {/* Authors */}
        <div className="flex items-center gap-3 mb-4">
          <SkeletonText className="h-4 w-36" />
          <SkeletonText className="h-4 w-28" />
          <SkeletonBlock className="h-4 w-4 rounded-full" />
        </div>

        {/* Keywords */}
        <div className="flex gap-1.5 mb-6">
          <SkeletonBlock className="h-5 w-16 rounded-full" />
          <SkeletonBlock className="h-5 w-20 rounded-full" />
          <SkeletonBlock className="h-5 w-14 rounded-full" />
          <SkeletonBlock className="h-5 w-18 rounded-full" />
        </div>

        {/* Metrics bar */}
        <div className="flex items-center gap-5 pb-6 border-b border-parchment-dark">
          <SkeletonBlock className="h-4 w-14" />
          <SkeletonBlock className="h-4 w-16" />
          <SkeletonBlock className="h-4 w-16" />
          <SkeletonBlock className="h-4 w-20" />
        </div>

        {/* Body lines */}
        <div className="mt-6 space-y-3">
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-5/6" />
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-4/5" />
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-3/4" />
          <SkeletonText className="h-4 w-full" />
          <SkeletonText className="h-4 w-2/3" />
        </div>
      </div>

      {/* Reviews section */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <SkeletonText className="h-6 w-40" />
          <SkeletonBlock className="h-9 w-32 rounded-md" />
        </div>

        {/* Review cards */}
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="card">
              <div className="flex items-center gap-2 mb-3">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-4 w-28" />
              </div>
              <div className="space-y-2">
                <SkeletonText className="h-4 w-full" />
                <SkeletonText className="h-4 w-5/6" />
                <SkeletonText className="h-4 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
