export type OrderSearchParams = Record<string, string | string[] | undefined>;

export function orderListQuery(input: OrderSearchParams) {
  const result = new URLSearchParams();
  for (const key of ["status", "type", "q", "sort"] as const) {
    const value = input[key];
    if (typeof value === "string" && value) result.set(key, value.slice(0, 200));
  }
  return result;
}

export function withOrderListQuery(path: string, input: OrderSearchParams) {
  const query = orderListQuery(input).toString();
  return query ? `${path}?${query}` : path;
}
