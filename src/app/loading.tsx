export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-[1680px] px-4 py-12 sm:px-6 lg:px-10 xl:px-14"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="h-10 w-64 bg-[#EFEFF2]" />
      <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((slot) => (
          <div
            key={slot}
            className="border border-[#D9D6E2] bg-white p-4"
          >
            <div className="aspect-[4/3] w-full bg-[#EFEFF2]" />
            <div className="mt-4 h-5 w-3/4 bg-[#EFEFF2]" />
            <div className="mt-2 h-4 w-1/2 bg-[#EFEFF2]" />
          </div>
        ))}
      </div>
    </div>
  );
}
