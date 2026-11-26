export default function LoadingFreeItems() {
  return <div aria-busy="true" aria-label="Loading Free Items" className="mx-auto max-w-[1200px] space-y-5 px-4 py-7 sm:px-6 lg:px-10">
    <div className="h-10 w-44 rounded-lg bg-surface-paper motion-safe:animate-pulse" />
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((key) => <div key={key} className="aspect-[4/3] rounded-xl bg-surface-paper motion-safe:animate-pulse" />)}
    </div>
  </div>;
}
