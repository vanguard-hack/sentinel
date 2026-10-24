// Vendored from beui.dev/components/agents/voice-orb (MIT, Saurabh).
// Ported to JavaScript: TypeScript types removed, `cn` (clsx + tailwind-merge)
// replaced by a plain class join and the Tailwind utilities by the vo-* rules
// in index.css. Behaviour, spring and colours are unchanged.

import {
  isMotionValue,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createOrbRenderer } from './renderer';

/** beui's lib/ease SPRING_GLIDE. */
const SPRING_GLIDE = { stiffness: 700, damping: 50, mass: 0.5 };

const DEFAULT_COLORS = ['#e8754d', '#ffe0ac', '#346b52'];
const level = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** A grainy liquid sphere whose surface and silhouette respond to voice activity. */
export function VoiceOrb({
  activity = 0,
  analyser = null,
  colors = DEFAULT_COLORS,
  active = true,
  speed = 1,
  onError,
  className,
  style,
  'aria-label': label,
  ...props
}) {
  const reducedMotion = useReducedMotion();
  const canvas = useRef(null);
  const renderer = useRef(null);
  const [error, setError] = useState(null);
  const target = useMotionValue(0);
  const smooth = useSpring(target, SPRING_GLIDE);
  const transform = useTransform(
    smooth,
    (value) =>
      `translate3d(0, ${-value * 2}px, 0) scale(${1 + value * 0.04}, ${1 - value * 0.018})`,
  );
  const latest = useRef({
    activity,
    analyser,
    colors,
    active,
    speed,
    reducedMotion,
    onError,
  });
  useLayoutEffect(() => {
    latest.current = {
      activity,
      analyser,
      colors,
      active,
      speed,
      reducedMotion,
      onError,
    };
    const value =
      active && !reducedMotion
        ? level(isMotionValue(activity) ? activity.get() : activity)
        : 0;
    if (reducedMotion) {
      smooth.jump(0);
      target.set(0);
    } else target.set(value);
    renderer.current?.requestDraw();
  });

  useEffect(() => {
    if (!isMotionValue(activity)) return undefined;
    return activity.on('change', (value) => {
      if (latest.current.active && !latest.current.reducedMotion)
        target.set(level(value));
      renderer.current?.requestDraw();
    });
  }, [activity, target]);

  useEffect(
    () => smooth.on('change', () => renderer.current?.requestDraw()),
    [smooth],
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    let sample = null;
    let audioSource = null;
    const failed = (failure) => {
      setError(failure);
      latest.current.onError?.(failure);
    };
    try {
      renderer.current = createOrbRenderer(
        element,
        () => {
          const current = latest.current;
          if (current.analyser && current.active && !current.reducedMotion) {
            if (
              audioSource !== current.analyser ||
              sample?.length !== current.analyser.fftSize
            ) {
              audioSource = current.analyser;
              sample = new Uint8Array(
                new ArrayBuffer(current.analyser.fftSize),
              );
            }
            if (sample) {
              current.analyser.getByteTimeDomainData(sample);
              let sum = 0;
              for (const byte of sample) sum += ((byte - 128) / 128) ** 2;
              target.set(level(Math.sqrt(sum / sample.length) * 3));
            }
          }
          return {
            activity:
              current.active && !current.reducedMotion
                ? level(smooth.get())
                : 0,
            colors: current.colors,
            speed: Number.isFinite(current.speed)
              ? Math.max(0, current.speed)
              : 1,
            animated:
              current.active &&
              !current.reducedMotion &&
              (current.speed > 0 || !!current.analyser),
          };
        },
        failed,
      );
    } catch (failure) {
      failed(failure instanceof Error ? failure : new Error(String(failure)));
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [smooth, target]);

  return (
    <div
      {...props}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="voice-orb"
      data-render-state={error ? 'error' : 'ready'}
      className={['vo-root', className].filter(Boolean).join(' ')}
      style={style}
    >
      {error ? (
        <div className="vo-error">
          Orb rendering unavailable
        </div>
      ) : (
        <motion.div
          className="vo-fill"
          style={{ transform: reducedMotion ? 'none' : transform }}
        >
          <canvas ref={canvas} className="vo-canvas" />
        </motion.div>
      )}
    </div>
  );
}
