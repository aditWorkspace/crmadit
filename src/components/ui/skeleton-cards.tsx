export function SkeletonCard() {
  return (
    <div className="rounded-lg border border-gray-100 bg-white p-4 space-y-3 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-3 w-28 bg-gray-200 rounded" />
        <div className="h-5 w-16 bg-gray-100 rounded-full" />
      </div>
      <div className="h-3 w-20 bg-gray-100 rounded" />
      <div className="h-3 w-24 bg-gray-100 rounded" />
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonKanban({ columns = 4, cardsPerColumn = 3 }: { columns?: number; cardsPerColumn?: number }) {
  return (
    <div className="flex gap-4">
      {Array.from({ length: columns }).map((_, col) => (
        <div key={col} className="flex-shrink-0 w-72 rounded-xl bg-gray-50 p-3 space-y-3">
          <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
          <SkeletonCards count={cardsPerColumn} />
        </div>
      ))}
    </div>
  );
}
