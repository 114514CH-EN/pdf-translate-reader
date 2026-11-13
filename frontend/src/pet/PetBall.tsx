/**
 * A ball to throw around the window. It has its own little simulation (gravity, bouncy
 * walls and floor, rolling friction) and tells the pet where it came to rest, so the
 * pet can walk over and kick it back.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export const BALL = 26;

export interface BallHandle {
  /** px/s; up is positive */
  kick(vx: number, vy: number): void;
  /** left edge, px */
  x(): number;
  resting(): boolean;
}

interface Props {
  /** distance of the floor from the bottom of the window */
  floor: number;
  /** where it first drops from (left edge) */
  startX: number;
  /** it has stopped on the floor; `byHand` when the last push came from the user */
  onRest: (x: number, byHand: boolean) => void;
  /** the user grabbed it */
  onGrab: () => void;
}

const G = 2400;
const BOUNCE = 0.62;

export const PetBall = forwardRef<BallHandle, Props>(function PetBall({ floor, startX, onRest, onGrab }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const s = useRef({ x: startX, y: Math.max(floor, window.innerHeight * 0.6), vx: 0, vy: 0, spin: 0, rest: false, held: false, byHand: true });
  const raf = useRef(0);
  const last = useRef(0);
  const [held, setHeld] = useState(false);
  const cb = useRef({ onRest, onGrab });
  cb.current = { onRest, onGrab };

  const paint = useCallback(() => {
    const n = el.current;
    if (!n) return;
    n.style.left = `${s.current.x}px`;
    n.style.bottom = `${s.current.y}px`;
    n.style.setProperty('--spin', `${s.current.spin}deg`);
  }, []);

  const tick = useCallback(
    (t: number) => {
      const b = s.current;
      const dt = Math.min(0.032, (t - (last.current || t)) / 1000);
      last.current = t;
      if (b.held || b.rest) {
        raf.current = 0;
        return;
      }
      const maxX = Math.max(0, window.innerWidth - BALL - 2);
      const top = Math.max(floor, window.innerHeight - BALL - 2);
      b.vy -= G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spin += b.vx * dt * 4.4;
      if (b.x < 2) {
        b.x = 2;
        b.vx = Math.abs(b.vx) * BOUNCE;
      } else if (b.x > maxX) {
        b.x = maxX;
        b.vx = -Math.abs(b.vx) * BOUNCE;
      }
      if (b.y > top) {
        b.y = top;
        b.vy = -Math.abs(b.vy) * BOUNCE;
      }
      if (b.y <= floor) {
        b.y = floor;
        if (Math.abs(b.vy) < 120) {
          b.vy = 0;
          b.vx *= Math.max(0, 1 - 2.6 * dt); // rolling
          if (Math.abs(b.vx) < 14) {
            b.vx = 0;
            b.rest = true;
            paint();
            cb.current.onRest(b.x, b.byHand);
            raf.current = 0;
            return;
          }
        } else {
          b.vy = Math.abs(b.vy) * BOUNCE;
          b.vx *= 0.86;
        }
      }
      paint();
      raf.current = requestAnimationFrame(tick);
    },
    [floor, paint],
  );

  const run = useCallback(() => {
    s.current.rest = false;
    if (raf.current) return;
    last.current = 0;
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => {
    paint();
    run();
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [paint, run]);

  useEffect(() => {
    const onResize = () => {
      if (!s.current.held) run();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [run]);

  useImperativeHandle(
    ref,
    () => ({
      kick(vx, vy) {
        const b = s.current;
        if (b.held) return;
        b.vx = vx;
        b.vy = vy;
        b.byHand = false;
        run();
      },
      x: () => s.current.x,
      resting: () => s.current.rest && !s.current.held,
    }),
    [run],
  );

  // dragging and throwing
  const grab = useRef<{ dx: number; dy: number; trail: { t: number; x: number; y: number }[] } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = s.current;
    b.held = true;
    b.rest = false;
    b.vx = 0;
    b.vy = 0;
    grab.current = { dx: e.clientX - b.x, dy: window.innerHeight - e.clientY - b.y, trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    setHeld(true);
    cb.current.onGrab();
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const b = s.current;
    b.x = Math.min(Math.max(2, e.clientX - g.dx), Math.max(2, window.innerWidth - BALL - 2));
    b.y = Math.min(Math.max(floor, window.innerHeight - e.clientY - g.dy), Math.max(floor, window.innerHeight - BALL - 2));
    g.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (g.trail.length > 6) g.trail.shift();
    paint();
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    grab.current = null;
    const b = s.current;
    const a = g.trail[0];
    const z = g.trail[g.trail.length - 1];
    const dt = Math.max(16, Math.min(z.t - a.t, 200)) / 1000;
    const stale = e.timeStamp - z.t > 90; // held still before letting go: just drop it
    const cap = (v: number) => Math.max(-2600, Math.min(2600, v));
    b.vx = stale ? 0 : cap((z.x - a.x) / dt);
    b.vy = stale ? 0 : cap(-(z.y - a.y) / dt);
    b.held = false;
    b.byHand = true;
    setHeld(false);
    run();
  };

  return (
    <div
      ref={el}
      className={`pet-ball${held ? ' is-held' : ''}`}
      role="button"
      tabIndex={0}
      title="拖起来扔出去，小页会追过去踢回来"
      aria-label="球：按方向键或回车抛一下"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={(e) => {
        const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'Enter' || e.key === ' ' ? (Math.random() < 0.5 ? -1 : 1) : 0;
        if (!dir) return;
        e.preventDefault();
        const b = s.current;
        b.vx = dir * 520;
        b.vy = 820;
        b.byHand = true;
        cb.current.onGrab();
        run();
      }}
    >
      <svg viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="13" cy="13" r="12" className="pet-ball-skin" />
        <path d="M2.2 9.5c5 3.2 16.6 3.2 21.6 0M2.2 16.5c5-3.2 16.6-3.2 21.6 0" className="pet-ball-seam" />
      </svg>
    </div>
  );
});
