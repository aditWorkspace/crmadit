export function SkeletonTable({ cols = 6, rows = 5 }: { cols?: number; rows?: number }) {
  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50">
              {Array.from({ length: cols }).map((_, i) => (
                <th key={i} className="px-4 py-2.5">
                  <div className="h-3 w-20 bg-gray-200 rounded animate-pulse" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c} className="px-4 py-3">
                    <div
                      className="h-3 bg-gray-100 rounded animate-pulse"
                      style={{ width: `${60 + ((r * cols + c) % 4) * 15}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
