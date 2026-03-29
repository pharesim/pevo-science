import { SkeletonText, SkeletonBlock } from "@/components/Skeleton";

/** Single stat card skeleton matching the StatCard component dimensions. */
function StatCardItemSkeleton() {
  return (
    <div className="card text-center">
      <SkeletonBlock className="h-10 w-20 mx-auto" />
      <SkeletonText className="h-4 w-32 mt-2 mx-auto" />
    </div>
  );
}

/** Grid of stat card skeletons. */
export default function StatCardSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }, (_, i) => (
        <StatCardItemSkeleton key={i} />
      ))}
    </div>
  );
}
