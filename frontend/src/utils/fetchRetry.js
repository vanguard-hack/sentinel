// A 429 from Sentinel's own function is never shown to the officer as an error.
//
// Two things answer 429 here: the Catalyst platform throttling a burst of
// invocations (stricter in Development), and the function's own per-officer
// limiter. Either way the request was refused BEFORE any handler ran, so
// sending it again is safe even for a write — nothing was half-done. Pages
// fire several calls at once, so a refusal used to surface as "HTTP 429" on a
// perfectly healthy connection; now it waits (Retry-After when given, a
// widening backoff otherwise) and asks again, inside a fixed time budget so a
// genuinely stuck platform still reports rather than hangs.
//
// Only 429, only calls to /server/ — other failures, and other hosts, pass
// straight through untouched.

const MAX_RETRIES = 4;
const BUDGET_MS = 30_000;

export function retryDelayMs(retryAfter, attempt) {
  const s = Number(retryAfter);
  if (retryAfter != null && retryAfter !== '' && Number.isFinite(s) && s >= 0) return s * 1000;
  return Math.min(8000, 1000 * 2 ** attempt) + Math.random() * 400;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => {
    clearTimeout(t);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

const isServerCall = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
  if (!url) return false;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return url.startsWith('/server/') || (!!origin && url.startsWith(`${origin}/server/`));
};

export function withRetryOn429(baseFetch) {
  return async function fetchRetrying(input, init) {
    // A stream body can only be sent once; leave those alone.
    const streamBody = init?.body && typeof init.body.getReader === 'function';
    if (!isServerCall(input) || streamBody) return baseFetch(input, init);
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await baseFetch(input, init);
      if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
      const ms = retryDelayMs(res.headers?.get?.('Retry-After'), attempt);
      if (Date.now() - started + ms > BUDGET_MS) return res;
      // eslint-disable-next-line no-await-in-loop
      await sleep(ms, init?.signal);
    }
  };
}

export function installFetchRetry() {
  if (typeof window === 'undefined' || !window.fetch || window.fetch.retriesOn429) return;
  const wrapped = withRetryOn429(window.fetch.bind(window));
  wrapped.retriesOn429 = true;
  window.fetch = wrapped;
}

export const RETRY_LIMITS = { MAX_RETRIES, BUDGET_MS };
