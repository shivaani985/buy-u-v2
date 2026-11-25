type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export async function readOrderPages<T>(
  fetchPage: (start: number, end: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  const size = 500;
  for (let start = 0; ; start += size) {
    const { data, error } = await fetchPage(start, start + size - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < size) return { data: rows, error: null };
  }
}

/** Keep PostgREST filters small even for accounts with long order histories. */
export async function readOrderRelations<T>(
  ids: string[],
  fetchPage: (batch: string[], start: number, end: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  const size = 60;
  for (let start = 0; start < ids.length; start += size) {
    const batch = ids.slice(start, start + size);
    const { data, error } = await readOrderPages((first, last) => fetchPage(batch, first, last));
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
  }
  return { data: rows, error: null };
}
