/**
 * Desktop-pet physics: what happens after it is dragged and let go.
 *
 *   bounce  — let go up high and it falls (gravity), bouncing a few times on the
 *             bottom edge and off the sides of the window
 *   inertia — fling it and it keeps the speed of your hand, then slides to a stop
 *
 * Both are switched in 设置 → 界面 → 桌宠 (and in the pet's right-click menu) and
 * kept per browser in localStorage. With both off the pet just drops back down as
 * before. "Reduce motion" in the OS turns the default off.
 */

export interface PhysicsSettings {
  bounce: boolean;
  inertia: boolean;
}

export const PHYSICS_KEY = 'pdftr.pet.physics';
export const PHYSICS_EVENT = 'pdftr:pet-physics';

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function loadPhysics(): PhysicsSettings {
  const fallback = { bounce: !reducedMotion(), inertia: !reducedMotion() };
  try {
    const raw = window.localStorage.getItem(PHYSICS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<PhysicsSettings>;
    return { bounce: v.bounce ?? fallback.bounce, inertia: v.inertia ?? fallback.inertia };
  } catch {
    return fallback;
  }
}

export function savePhysics(next: PhysicsSettings): void {
  try {
    window.localStorage.setItem(PHYSICS_KEY, JSON.stringify(next));
  } catch {
    /* private window: the setting lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent<PhysicsSettings>(PHYSICS_EVENT, { detail: next }));
}

/** Pointer samples while dragging → release velocity (px/s, y up). */
export class VelocityTracker {
  private pts: { t: number; x: number; y: number }[] = [];

  reset(): void {
    this.pts = [];
  }

  add(x: number, y: number, t = performance.now()): void {
    this.pts.push({ t, x, y });
    while (this.pts.length > 2 && t - this.pts[0].t > 90) this.pts.shift();
  }

  /** velocity over the last ~90 ms; a hand that stopped before letting go gives ~0 */
  velocity(now = performance.now()): { vx: number; vy: number } {
    const pts = this.pts.filter((p) => now - p.t <= 120);
    if (pts.length < 2) return { vx: 0, vy: 0 };
    const a = pts[0];
    const b = pts[pts.length - 1];
    const dt = Math.max((b.t - a.t) / 1000, 0.008);
    // screen y grows downwards; the pet's y (distance from the bottom) grows upwards
    return { vx: (b.x - a.x) / dt, vy: -(b.y - a.y) / dt };
  }
}

export interface Body {
  x: number; // left, px
  y: number; // distance of its feet from the bottom edge, px
  vx: number; // px/s
  vy: number; // px/s, up is positive
}

export interface World {
  minX: number;
  maxX: number;
  ground: number; // y of the floor
  ceiling: number; // highest y
}

export interface StepResult {
  /** hit the floor this step with this downward speed (px/s) — for the squash */
  landed: number;
  /** hit a side wall this step with this sideways speed (px/s) */
  wall: number;
  /** resting on the floor and (almost) still: the simulation is over */
  done: boolean;
}

const GRAVITY = 2400; // px/s²
const MAX_SPEED = 3200; // px/s — a wild fling should not teleport it
const FLOOR_BOUNCE = 0.5; // share of the speed kept when it hits the floor
const WALL_BOUNCE = 0.55;
const AIR_DRAG = 0.35; // per second
const FLOOR_FRICTION = 7; // per second, while sliding on the floor
const MIN_BOUNCE = 180; // below this downward speed it stops bouncing and lands

/** Advance one step of `dt` seconds (call with dt ≤ 1/30). Mutates `b`. */
export function step(b: Body, w: World, dt: number, s: PhysicsSettings): StepResult {
  let landed = 0;
  let wall = 0;
  const speed = Math.hypot(b.vx, b.vy);
  if (speed > MAX_SPEED) {
    b.vx *= MAX_SPEED / speed;
    b.vy *= MAX_SPEED / speed;
  }
  const onFloor = b.y <= w.ground + 0.5 && Math.abs(b.vy) < 1;
  if (!onFloor) b.vy -= GRAVITY * dt;
  b.vx *= Math.max(0, 1 - (onFloor ? FLOOR_FRICTION : AIR_DRAG) * dt);
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // sides of the window
  if (b.x < w.minX || b.x > w.maxX) {
    b.x = b.x < w.minX ? w.minX : w.maxX;
    wall = Math.abs(b.vx);
    b.vx = s.bounce ? -b.vx * WALL_BOUNCE : 0;
  }
  // top of the window
  if (b.y > w.ceiling) {
    b.y = w.ceiling;
    if (b.vy > 0) b.vy = s.bounce ? -b.vy * 0.3 : 0;
  }
  // the bottom edge
  if (b.y <= w.ground) {
    b.y = w.ground;
    if (b.vy < 0) {
      landed = -b.vy;
      b.vy = s.bounce && -b.vy > MIN_BOUNCE ? -b.vy * FLOOR_BOUNCE : 0;
      if (b.vy === 0) b.vx *= 0.7; // a hard landing eats some of the slide
    }
  }
  const done = b.y <= w.ground + 0.5 && b.vy === 0 && Math.abs(b.vx) < 12;
  return { landed, wall, done };
}
