/* Getting off the main thread's way.
 *
 * Two problems, one file.
 *
 * THE CLICK THAT DOES NOTHING. A tab's model is built in an async function, and
 * an `await` on an already-resolved promise resumes in a MICROTASK — which runs
 * before the browser paints. So a component could mount showing a spinner,
 * start its build, and block for half a second without the spinner ever
 * reaching the screen. The click looked ignored. `breathe()` is a real yield
 * back to the event loop, not a microtask, so whatever was committed actually
 * gets drawn before the work starts.
 *
 * THE WORK NOBODY ASKED FOR YET. The five analytics tabs are read-only models
 * that will almost certainly all be opened in a session. Building them while
 * the officer is reading the first one costs nothing they can feel and makes
 * every later tab open instantly — provided it happens when the browser is
 * genuinely idle, and one at a time, so it never competes with what they are
 * actually doing.
 */

/** Yield to the event loop. `scheduler.yield` resumes at the front of the
 *  queue where it exists; setTimeout is the fallback everywhere else. */
export const breathe = () => {
  const sched = typeof window !== 'undefined' ? window.scheduler : null;
  return sched && typeof sched.yield === 'function'
    ? sched.yield()
    : new Promise((r) => { setTimeout(r, 0); });
};

/** Yield until after the next paint, so a spinner or a new tab is on screen
 *  before a long synchronous build begins. */
export const afterPaint = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
  requestAnimationFrame(() => setTimeout(resolve, 0));
});

/** Resolve when the browser is idle (or after `timeout`, so a busy page still
 *  gets there eventually). */
export const whenIdle = (timeout = 2000) => new Promise((resolve) => {
  const ric = typeof window !== 'undefined' ? window.requestIdleCallback : null;
  if (typeof ric === 'function') ric(() => resolve(), { timeout });
  else setTimeout(resolve, 200);
});

/**
 * Build a list of models in the background, one at a time, each waiting for an
 * idle moment first.
 *
 * Sequential on purpose: four models started at once would fight each other and
 * the page the officer is actually looking at. A failure is swallowed — this is
 * speculative work, and the tab that needs it will surface its own error when
 * it is opened for real.
 *
 * Returns a stop function, so leaving the page cancels whatever has not started.
 */
export function warmInBackground(tasks) {
  let stopped = false;
  (async () => {
    for (const task of tasks) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await whenIdle();
      if (stopped) return;
      try {
        // eslint-disable-next-line no-await-in-loop
        await task();
      } catch { /* speculative: the tab reports its own failure when opened */ }
    }
  })();
  return () => { stopped = true; };
}
