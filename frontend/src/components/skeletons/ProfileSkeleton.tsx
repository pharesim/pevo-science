import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Skeleton for the profile page: header card, stats grid, reputation breakdown, paper list. */
export default function ProfileSkeleton() {
  return (
    <div className="container-narrow py-8">
      {/* Profile header card */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <SkeletonText className="h-7 w-48" />
              <SkeletonBlock className="h-5 w-5 rounded-full" />
            </div>
            <SkeletonText className="h-4 w-28 mb-2" />
            <SkeletonText className="h-4 w-36 mt-2" />
            <SkeletonText className="h-4 w-24 mt-1" />
          </div>
          <div className="text-center sm:text-right">
            <SkeletonBlock className="h-12 w-16 mx-auto sm:ml-auto sm:mr-0" />
            <SkeletonText className="h-3 w-20 mt-1 mx-auto sm:ml-auto sm:mr-0" />
          </div>
        </div>
      </div>

      {/* Stats + Reputation breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Activity stats */}
        <div className="card">
          <SkeletonText className="h-5 w-24 mb-4" />
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="text-center">
                <SkeletonBlock className="h-8 w-12 mx-auto" />
                <SkeletonText className="h-3 w-16 mt-1 mx-auto" />
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-parchment-dark">
            <SkeletonText className="h-3 w-40" />
          </div>
        </div>

        {/* Reputation breakdown */}
        <div className="card">
          <SkeletonText className="h-5 w-40 mb-4" />
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <SkeletonText className="h-4 w-24 shrink-0" />
                <SkeletonBlock className="h-2 flex-1 rounded-full" />
                <SkeletonText className="h-4 w-8" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Papers section */}
      <SkeletonText className="h-6 w-36 mb-4" />
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="card">
            <div className="flex items-center justify-between mb-3">
              <SkeletonBlock className="h-5 w-20" />
              <SkeletonBlock className="h-4 w-28" />
            </div>
            <SkeletonText className="h-6 w-4/5 mb-2" />
            <div className="space-y-2 mb-4">
              <SkeletonText className="h-4 w-full" />
              <SkeletonText className="h-4 w-3/4" />
            </div>
            <div className="flex items-center gap-5 pt-3 border-t border-parchment-dark">
              <SkeletonBlock className="h-4 w-12" />
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="h-4 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
