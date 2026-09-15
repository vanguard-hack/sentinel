/* Why clicking Crime Links used to do nothing.
 *
 * The model is built inside an async function, and `await` on an
 * already-resolved promise resumes in a MICROTASK — which runs before the
 * browser paints. So the component could mount with a spinner, commit it, then
 * block the main thread for half a second building the network, and the
 * spinner never reached the screen. The click looked ignored, then the page
 * appeared all at once.
 *
 * Three things fix it, and all three are pinned here: the build waits for a
 * paint before it starts, the layout yields while it runs, and the tabs the
 * officer has not opened yet are built in the background so the click has
 * nothing left to pay for.
 */
import { afterPaint, breathe, whenIdle, warmInBackground } from '../utils/idle';
import { layoutForce, layoutForceAsync, seededRandom } from '../utils/graphLayout';

const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: i, r: 10 + (i % 5), x: 0, y: 0 }));
const links = (n) => Array.from({ length: n - 1 }, (_, i) => ({ s: i, t: i + 1 }));

describe('yielding', () => {
  test('afterPaint waits for a frame, not just a microtask', async () => {
    let frames = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { frames += 1; return raf ? raf(cb) : setTimeout(cb, 0); };
    await afterPaint();
    window.requestAnimationFrame = raf;
    expect(frames).toBe(1);
  });

  test('breathe lets a timer run — a microtask would not', async () => {
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    await Promise.resolve();          // a microtask hop: the timer cannot have run
    expect(ticked).toBe(false);
    await breathe();
    expect(ticked).toBe(true);
  });

  test('whenIdle resolves even on a page that is never idle', async () => {
    const ric = window.requestIdleCallback;
    delete window.requestIdleCallback;
    await expect(whenIdle(50)).resolves.toBeUndefined();
    if (ric) window.requestIdleCallback = ric;
  });
});

describe('the ring-map layout', () => {
  test('the yielded run lays out identically to the blocking one', async () => {
    const a = nodes(40);
    const b = nodes(40);
    layoutForce(a, links(40), seededRandom(0x5E27));
    await layoutForceAsync(b, links(40), seededRandom(0x5E27));
    expect(b.map((n) => [n.x.toFixed(9), n.y.toFixed(9)]))
      .toEqual(a.map((n) => [n.x.toFixed(9), n.y.toFixed(9)]));
  });

  test('and hands the browser back while it runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await layoutForceAsync(nodes(120), links(120), seededRandom(1), 420, { sliceMs: 0 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('background warming', () => {
  test('builds the other tabs one at a time, never all at once', async () => {
    const order = [];
    let live = 0;
    let peak = 0;
    const task = (name) => async () => {
      live += 1; peak = Math.max(peak, live);
      order.push(name);
      await new Promise((r) => { setTimeout(r, 5); });
      live -= 1;
    };
    warmInBackground([task('a'), task('b'), task('c')]);
    // jsdom has no requestIdleCallback, so each step waits out the fallback.
    await new Promise((r) => { setTimeout(r, 1200); });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
  });

  test('one failed warm does not stop the rest — it is speculative work', async () => {
    const done = [];
    warmInBackground([
      () => Promise.reject(new Error('snapshot refused')),
      () => { done.push('b'); return Promise.resolve(); },
    ]);
    await new Promise((r) => { setTimeout(r, 1200); });
    expect(done).toEqual(['b']);
  });

  test('leaving the page stops whatever has not started', async () => {
    const done = [];
    const stop = warmInBackground([
      async () => { done.push('a'); await new Promise((r) => { setTimeout(r, 5); }); },
      () => { done.push('b'); return Promise.resolve(); },
    ]);
    stop();
    await new Promise((r) => { setTimeout(r, 1200); });
    expect(done).not.toContain('b');
  });
});
