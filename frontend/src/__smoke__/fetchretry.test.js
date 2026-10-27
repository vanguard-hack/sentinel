// "HTTP 429" on a healthy connection: the platform (or the function's own
// limiter) refusing a burst. Every call to /server/ now waits and asks again
// instead of surfacing it — but only for 429, only for our function, and only
// within a time budget.
import { withRetryOn429, retryDelayMs, RETRY_LIMITS } from '../utils/fetchRetry';

const res = (status, retryAfter = '0') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (h) => (h === 'Retry-After' ? retryAfter : null) },
});

test('a 429 from the function is retried until it succeeds', async () => {
  const base = jest.fn()
    .mockResolvedValueOnce(res(429))
    .mockResolvedValueOnce(res(429))
    .mockResolvedValueOnce(res(200));
  const r = await withRetryOn429(base)('/server/rag/access/me', { method: 'POST', body: '{}' });
  expect(r.status).toBe(200);
  expect(base).toHaveBeenCalledTimes(3);
  // Same request each time — the body is sent again, not lost.
  expect(base.mock.calls.every(([u, i]) => u === '/server/rag/access/me' && i.body === '{}')).toBe(true);
});

test('absolute same-origin URLs to /server/ are covered too', async () => {
  const base = jest.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
  await withRetryOn429(base)(`${window.location.origin}/server/rag/x`);
  expect(base).toHaveBeenCalledTimes(2);
});

test('another host with a /server/ path is not ours and is not retried', async () => {
  const base = jest.fn().mockResolvedValue(res(429));
  await withRetryOn429(base)('https://elsewhere.example/server/x');
  expect(base).toHaveBeenCalledTimes(1);
});

test('other failures are answers, not retried', async () => {
  for (const status of [400, 401, 403, 500, 503]) {
    const base = jest.fn().mockResolvedValue(res(status));
    // eslint-disable-next-line no-await-in-loop
    const r = await withRetryOn429(base)('/server/rag/x');
    expect(r.status).toBe(status);
    expect(base).toHaveBeenCalledTimes(1);
  }
});

test('calls to other hosts are passed through untouched', async () => {
  const base = jest.fn().mockResolvedValue(res(429));
  await withRetryOn429(base)('https://ifsc.razorpay.com/KARB0000001');
  expect(base).toHaveBeenCalledTimes(1);
});

test('a platform that keeps refusing is reported after the retry cap, not hung on', async () => {
  const base = jest.fn().mockResolvedValue(res(429));
  const r = await withRetryOn429(base)('/server/rag/x');
  expect(r.status).toBe(429);
  expect(base).toHaveBeenCalledTimes(RETRY_LIMITS.MAX_RETRIES + 1);
});

test('a Retry-After beyond the time budget is not waited out', async () => {
  const base = jest.fn().mockResolvedValue(res(429, '45'));
  const r = await withRetryOn429(base)('/server/rag/x');
  expect(r.status).toBe(429);
  expect(base).toHaveBeenCalledTimes(1);
});

test('Retry-After is honoured; without it the backoff widens', () => {
  expect(retryDelayMs('3', 0)).toBe(3000);
  expect(retryDelayMs(null, 0)).toBeGreaterThanOrEqual(1000);
  expect(retryDelayMs(null, 3)).toBeGreaterThanOrEqual(8000);
  expect(retryDelayMs(null, 9)).toBeLessThan(8400); // capped
});

test('an aborted request stops waiting', async () => {
  const base = jest.fn().mockResolvedValue(res(429, '5'));
  const ctl = new AbortController();
  const p = withRetryOn429(base)('/server/rag/x', { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await expect(p).rejects.toBeTruthy();
});
