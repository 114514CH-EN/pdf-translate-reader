/**
 * Desktop-pet physics: what happens after it is dragged and let go.
 *
 *   bounce  — let go up high and it falls (gravity), bouncing on the bottom edge, off the
 *             sides and the top of the window; a soft body, so hard hits bounce less; with
 *             enough speed along the floor it rolls, then gets back on its feet
 *   inertia — fling it and it keeps the speed (and the swing) of your hand
 *   poke    — a fast swipe of the pointer through it knocks it away
 *   gravity — earth / moon / feather
 *
 * While dragged it hangs from the pointer and swings like a pendulum.
 *
 * Both are switched in 设置 → 界面 → 桌宠 (and in the pet's right-click menu) and
 * kept per browser in localStorage. With both off the pet just drops back down as
 * before. "Reduce motion" in the OS turns the default off.
 */

export type GravityMode = 'earth' | 'moon' | 'feather';

export interface PhysicsSettings {
  bounce: boolean;
  inertia: boolean;
  /** a fast swipe of the pointer through it knocks it away */
  poke: boolean;
  /** how heavy it is: 地球 / 月球（跳得高、落得慢）/ 羽毛（飘下来） */
  gravity: GravityMode;
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
  const on = !reducedMotion();
  const fallback: PhysicsSettings = { bounce: on, inertia: on, poke: on, gravity: 'earth' };
  try {
    const raw = window.localStorage.getItem(PHYSICS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<PhysicsSettings>;
    return {
      bounce: v.bounce ?? fallback.bounce,
      inertia: v.inertia ?? fallback.inertia,
      poke: v.poke ?? fallback.poke,
      gravity: v.gravity === 'moon' || v.gravity === 'feather' ? v.gravity : 'earth',
    };
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
  /** rotation, degrees clockwise; 0 = upright */
  a: number;
  /** spin, degrees per second */
  w: number;
  /** seconds simulated so far (the feather's sway) */
  t: number;
}

export interface World {
  minX: number;
  maxX: number;
  ground: number; // y of the floor
  ceiling: number; // highest y
  /** half its size, px: how far it travels per turn when it rolls */
  radius: number;
}

export interface StepResult {
  /** hit the floor this step with this downward speed (px/s) — for the squash */
  landed: number;
  /** hit a side wall this step with this sideways speed (px/s) */
  wall: number;
  /** bumped its head on the top edge with this speed */
  ceiling: number;
  /** resting on the floor and (almost) still: the simulation is over */
  done: boolean;
}

const GRAVITY = 2400; // px/s² on "earth"
export const GRAVITY_FACTOR: Record<GravityMode, number> = { earth: 1, moon: 0.28, feather: 0.07 };
const MAX_SPEED = 3200; // px/s — a wild fling should not teleport it
const AIR_DRAG = 0.35; // per second
const FEATHER_DRAG = 2.2; // a feather is all drag: it reaches a slow, steady fall
const SLIDE_FRICTION = 1700; // px/s² — sliding on its feet stops quickly…
const ROLL_FRICTION = 520; // …rolling carries much further
const ROLL_MIN = 150; // px/s along the floor before it starts to roll
const MIN_BOUNCE = 170; // below this downward speed it stops bouncing and lands
const RAD = 180 / Math.PI;

/** Soft body: a gentle drop keeps most of its speed, a hard slam loses more of it. */
export function restitution(speed: number): number {
  return Math.min(0.62, Math.max(0.38, 0.66 - speed / 8000));
}

/** Advance one step of `dt` seconds (call with dt ≤ 1/30). Mutates `b`. */
export function step(b: Body, w: World, dt: number, s: PhysicsSettings): StepResult {
  let landed = 0;
  let wall = 0;
  let ceiling = 0;
  const g = GRAVITY * GRAVITY_FACTOR[s.gravity];
  const speed = Math.hypot(b.vx, b.vy);
  if (speed > MAX_SPEED) {
    b.vx *= MAX_SPEED / speed;
    b.vy *= MAX_SPEED / speed;
  }
  b.t += dt;
  const onFloor = b.y <= w.ground + 0.5 && Math.abs(b.vy) < 1;
  if (!onFloor) {
    b.vy -= g * dt;
    if (s.gravity === 'feather') {
      const k = Math.max(0, 1 - FEATHER_DRAG * dt);
      b.vx = b.vx * k + Math.sin(b.t * 2.6) * 150 * dt; // drifts from side to side on the way down
      b.vy *= k;
    } else {
      b.vx *= Math.max(0, 1 - AIR_DRAG * dt);
    }
    b.w *= Math.max(0, 1 - 0.5 * dt);
  } else {
    // on the floor: fast enough and it rolls (turning as far as it travels), else it slides to a stop
    const rolling = s.bounce && (Math.abs(b.vx) > ROLL_MIN || Math.abs(b.w) > 90);
    const slow = (rolling ? ROLL_FRICTION : SLIDE_FRICTION) * dt;
    b.vx = Math.abs(b.vx) <= slow ? 0 : b.vx - Math.sign(b.vx) * slow;
    b.w = rolling ? (b.vx / Math.max(w.radius, 8)) * RAD : 0;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.a += b.w * dt;

  // sides of the window
  if (b.x < w.minX || b.x > w.maxX) {
    b.x = b.x < w.minX ? w.minX : w.maxX;
    wall = Math.abs(b.vx);
    b.vx = s.bounce ? -b.vx * restitution(wall) : 0;
    b.w = -b.w * 0.5; // the wall kicks the spin back
  }
  // top of the window
  if (b.y > w.ceiling) {
    b.y = w.ceiling;
    if (b.vy > 0) {
      ceiling = b.vy;
      b.vy = s.bounce ? -b.vy * 0.45 : 0;
    }
  }
  // the bottom edge
  if (b.y <= w.ground) {
    b.y = w.ground;
    if (b.vy < 0) {
      landed = -b.vy;
      const bounces = s.bounce && landed > MIN_BOUNCE * Math.sqrt(GRAVITY_FACTOR[s.gravity]);
      b.vy = bounces ? landed * restitution(landed) : 0;
      b.vx *= bounces ? 0.86 : 0.7; // the floor grips it a little on every touch
      if (s.bounce) b.w = b.w * 0.5 + ((b.vx / Math.max(w.radius, 8)) * RAD) * 0.5; // …and turns the slide into spin
    }
  }
  const done = b.y <= w.ground + 0.5 && b.vy === 0 && Math.abs(b.vx) < 12;
  return { landed, wall, ceiling, done };
}

/** The upright angle nearest to `a` (it gets back on its feet the short way round). */
export function upright(a: number): number {
  return Math.round(a / 360) * 360;
}

/**
 * Hanging from the pointer while dragged: a damped pendulum pushed by how the hand
 * moves. Returns the new [angle, angular speed] (degrees, degrees/s).
 */
export function swing(theta: number, omega: number, handVx: number, dt: number): [number, number] {
  const target = Math.max(-42, Math.min(42, -handVx / 28)); // trails behind the hand
  const acc = -70 * (theta - target) - 5 * omega;
  const w = omega + acc * dt;
  return [theta + w * dt, w];
}
