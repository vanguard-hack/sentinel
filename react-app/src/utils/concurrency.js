// Runs `fn` over `items` with at most `limit` in flight at once, preserving
// input order in the result — a small worker pool rather than a bare
// Promise.all, which runs everything at once regardless of how many items
// there are.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
