/**
 * 桌宠版阅读助手：小页。它趴在窗口下沿，会走动、被拖着甩、被划词叫醒，
 * 用它头顶的对话气泡回答问题。对话能力全部来自 useChatStore —— 和后端
 * /api/documents/{id}/chat 的 SSE 流式没有一行区别，这里只是换了个身体。
 *
 * 它还会：按走路方向转身；很久没动静就睡着，你划词 / 打字时竖起耳朵；
 * 气泡关着时答完了会跳一跳提醒你；右键有菜单；可以设成安静或者藏到角落；
 * 在一页停留一会儿，看到公式 / 表格 / 大段文字时主动问要不要讲讲。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { useChatStore } from '../stores/chat';
import { useDocStore } from '../stores/doc';
import { useSettingsStore } from '../stores/settings';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { AssistantMode, Block } from '../types';
import {
  BREAK_MIN,
  FOCUS_CHOICES,
  addFocus,
  addMinute,
  clock,
  loadFocus,
  loadStats,
  recordPage,
  saveFocus,
  saveStats,
  startBreak,
  startFocus,
  summary,
  type FocusState,
  type Stats,
} from './companion';
import { ACT_MS, MOOD_NAME, moodOf, perform, trick, type ActName, type Mood } from './moods';
import { PetBody, type PetBadge, type PetMood } from './PetBody';
import {
  DEFAULT_APPEARANCE,
  PET_SIZE_MAX,
  PET_SIZE_MIN,
  POSE_SLOTS,
  loadAppearance,
  looksLikeImageUrl,
  saveAppearance,
  uploadedUrl,
  type Appearance,
  type Facing,
  type PoseSlot,
} from './appearance';
import { PET_SUMMON_EVENT } from './mode';
import { loadPhysics, PHYSICS_EVENT, savePhysics, step, VelocityTracker, type Body, type PhysicsSettings } from './physics';
import './pet.css';

/** distance of the pet's feet from the bottom of the window — above the status bar */
const GROUND = 32;
const BUBBLE_MAX_W = 416;
const POS_KEY = 'pdftr.pet.pos';
const PRESENCE_KEY = 'pdftr.pet.presence';
const TIPS_KEY = 'pdftr.pet.tips';

/** no pointer / key / wheel for this long and the pet dozes off */
const SLEEP_AFTER_MS = 3 * 60 * 1000;
/** how long to stay on a page before the pet offers help with it */
const TIP_DWELL_MS = 8000;
/** at least this long between two offers (grows each time one is turned down) */
const TIP_COOLDOWN_MS = 150 * 1000;
const TIP_SHOW_MS = 16000;

/** normal: 走动、主动提示；quiet: 原地不动、不搭话；hidden: 缩在右下角，划词或点它才出来 */
type Presence = 'normal' | 'quiet' | 'hidden';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function readStore<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) {
      const v = parse(raw);
      if (v !== undefined) return v;
    }
  } catch {
    /* first run, or storage blocked */
  }
  return fallback;
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

function readRatio(): number {
  return readStore(
    POS_KEY,
    (raw) => {
      const v = JSON.parse(raw) as { ratio?: unknown };
      return typeof v.ratio === 'number' && Number.isFinite(v.ratio) ? clamp(v.ratio, 0, 1) : undefined;
    },
    0.66,
  );
}

/** A stored question looks like "> quote\n\nquestion". */
function splitQuote(content: string): { quote: string; text: string } {
  const m = /^> ([\s\S]*?)\n\n([\s\S]*)$/.exec(content);
  return m ? { quote: m[1], text: m[2] } : { quote: '', text: content };
}

const short = (t: string, n = 18) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);

/** What the pet offers for a page, decided from the blocks already loaded for it. */
const DIZZY = ['晕……', '轻一点嘛', '哎哟！', '转、转起来了……'];
const PURR = ['嘿嘿', '好舒服～', '再摸摸', '(*ˊᗜˋ*)'];
/** minutes of reading before it suggests a break */
const BREAK_AFTER_MIN = 45;

interface TipOffer {
  text: string;
  ask: string;
  mode: AssistantMode;
}

function offerFor(pageNo: number, blocks: Block[]): TipOffer | null {
  const formulaBlocks = blocks.filter((b) => b.type === 'formula').length;
  const inlineMath = blocks.reduce((n, b) => n + (b.type === 'formula' ? 0 : b.meta?.math?.length ?? 0), 0);
  const tables = blocks.filter((b) => b.type === 'table').length;
  const chars = blocks
    .filter((b) => b.type === 'paragraph' || b.type === 'list' || b.type === 'heading')
    .reduce((n, b) => n + (b.text?.length ?? 0), 0);

  if (formulaBlocks >= 1 || inlineMath >= 4) {
    const n = formulaBlocks || inlineMath;
    return {
      text: formulaBlocks ? `这页有 ${n} 个公式，要我讲讲吗？` : `这页有好几处公式（${n} 处），要我讲讲吗？`,
      ask: `讲讲第 ${pageNo} 页的公式：每个公式在说什么、各个符号是什么意思，以及它在这里怎么用。`,
      mode: 'ask',
    };
  }
  if (tables >= 1) {
    return {
      text: tables > 1 ? `这页有 ${tables} 张表，要我帮你读一下重点吗？` : '这页有张表，要我帮你读一下重点吗？',
      ask: `帮我读一下第 ${pageNo} 页的表格：每一列是什么意思，有哪些值得注意的数字或规律。`,
      mode: 'ask',
    };
  }
  if (chars > 1600) {
    return { text: '这页字挺多的，要我先帮你总结一下吗？', ask: '总结本页', mode: 'page' };
  }
  return null;
}

export function PetAssistant() {
  const docId = useDocStore((s) => s.activeId);
  const docTitle = useDocStore((s) => s.documents.find((d) => String(d.id) === String(s.activeId))?.title);

  const summaryMd = useChatStore((s) => s.summaryMd);
  const questions = useChatStore((s) => s.questions);
  const notConfigured = useChatStore((s) => s.notConfigured);
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const streaming = useChatStore((s) => s.streaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const loadFor = useChatStore((s) => s.loadFor);
  const send = useChatStore((s) => s.send);
  const regenerate = useChatStore((s) => s.regenerate);
  const stop = useChatStore((s) => s.stopStreaming);
  const clear = useChatStore((s) => s.clearHistory);
  const refreshSummary = useChatStore((s) => s.refreshSummary);

  const currentPage = useViewStore((s) => s.currentPage);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const openSettings = useViewStore((s) => s.openSettings);
  const toast = useViewStore((s) => s.toast);
  const copyFromTranslation = useSettingsStore((s) => s.copyAssistantFromTranslation);

  const [pos, setPos] = useState({ x: 0, y: GROUND });
  const posRef = useRef(pos);
  const [placed, setPlaced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [walking, setWalking] = useState(false);
  /** which way it is heading — the picture is flipped to match */
  const [heading, setHeading] = useState<'left' | 'right'>('left');

  const [open, setOpenState] = useState(false);
  const openRef = useRef(open);
  const [history, setHistory] = useState(false);
  const [picking, setPicking] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [urlDraft, setUrlDraft] = useState(() => {
    const a = loadAppearance();
    return a.kind === 'url' ? a.url : '';
  });
  const [uploading, setUploading] = useState(false);
  const [stripping, setStripping] = useState(false);
  const [poseBusy, setPoseBusy] = useState<PoseSlot | null>(null);
  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);

  const [presence, setPresenceState] = useState<Presence>(() =>
    readStore<Presence>(PRESENCE_KEY, (r) => (r === 'quiet' || r === 'hidden' || r === 'normal' ? r : undefined), 'normal'),
  );
  const presenceRef = useRef(presence);
  const [focus, setFocusState] = useState<FocusState | null>(() => loadFocus());
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const focusPhase = focus?.phase ?? null;
  const [tipsOn, setTipsOnState] = useState(() => readStore(TIPS_KEY, (r) => (r === 'off' ? false : r === 'on' ? true : undefined), true));
  /** null = awake; idle = dozed off by itself (any activity wakes it); manual = told to sleep (wakes when clicked) */
  const [sleep, setSleepState] = useState<null | 'idle' | 'manual'>(null);
  const sleepRef = useRef(sleep);
  const [listening, setListening] = useState(false);
  const [typing, setTyping] = useState(false);
  const [unread, setUnread] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<(TipOffer & { page: number }) | null>(null);
  const [settling, setSettling] = useState(false);
  /** thrown / falling under the physics simulation (see physics.ts) */
  const [flying, setFlying] = useState(false);
  /** the pet's element: while dragged or flying its position is written straight to the DOM */
  const rootRef = useRef<HTMLDivElement>(null);
  /** a short line the pet says by itself (no buttons), gone after a few seconds */
  const [say, setSay] = useState<string | null>(null);
  const sayTimer = useRef(0);
  const speak = useCallback((text: string, ms = 4200) => {
    window.clearTimeout(sayTimer.current);
    setSay(text);
    sayTimer.current = window.setTimeout(() => setSay(null), ms);
  }, []);
  /** little effects over its head: hearts when stroked, stars when it hits something hard */
  const [fx, setFx] = useState<{ kind: 'hearts' | 'stars'; n: number } | null>(null);
  const fxTimer = useRef(0);
  const burst = useCallback((kind: 'hearts' | 'stars', ms = 1500) => {
    window.clearTimeout(fxTimer.current);
    setFx((f) => ({ kind, n: (f?.n ?? 0) + 1 }));
    fxTimer.current = window.setTimeout(() => setFx(null), ms);
  }, []);
  useEffect(() => () => {
    window.clearTimeout(sayTimer.current);
    window.clearTimeout(fxTimer.current);
  }, []);
  /** landing squash: alternates a/b so the animation restarts on every bounce */
  const [landing, setLanding] = useState<'' | 'a' | 'b'>('');
  const [physics, setPhysicsState] = useState<PhysicsSettings>(() => loadPhysics());
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  useEffect(() => {
    const on = (e: Event) => setPhysicsState((e as CustomEvent<PhysicsSettings>).detail ?? loadPhysics());
    window.addEventListener(PHYSICS_EVENT, on);
    return () => window.removeEventListener(PHYSICS_EVENT, on);
  }, []);

  const setOpen = useCallback((next: boolean | ((o: boolean) => boolean)) => {
    setOpenState((o) => {
      const v = typeof next === 'function' ? next(o) : next;
      openRef.current = v;
      return v;
    });
  }, []);
  const setSleep = useCallback((v: null | 'idle' | 'manual') => {
    sleepRef.current = v;
    setSleepState(v);
  }, []);

  const size = appearance.size;
  // handlers and effects read the current edge length through a ref
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const maxX = useCallback(() => Math.max(0, window.innerWidth - sizeRef.current - 14), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const poseFileRef = useRef<HTMLInputElement>(null);
  const poseTarget = useRef<PoseSlot | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);

  /** Keep the ref in step with the state synchronously — pointerup needs the final x. */
  const place = useCallback((next: { x: number; y: number }) => {
    posRef.current = next;
    setPos(next);
  }, []);

  /**
   * Move without a React render: 60 moves a second while dragged or flying would
   * re-render the whole assistant (chat history included) every frame. The state
   * catches up with `place` when the movement ends; renders in between read posRef.
   */
  const moveFast = useCallback((next: { x: number; y: number }, tilt = 0) => {
    posRef.current = next;
    const el = rootRef.current;
    if (!el) return;
    el.style.left = `${next.x}px`;
    el.style.bottom = `${next.y}px`;
    el.style.transform = tilt ? `rotate(${tilt.toFixed(1)}deg)` : '';
  }, []);

  // growing the pet near the right edge would push it off screen
  const lastSize = useRef(size);
  useEffect(() => {
    if (lastSize.current === size) return;
    lastSize.current = size;
    place({ x: Math.min(posRef.current.x, maxX()), y: GROUND });
  }, [size, maxX, place]);

  const setPresence = useCallback(
    (p: Presence) => {
      presenceRef.current = p;
      setPresenceState(p);
      writeStore(PRESENCE_KEY, p);
      setTip(null);
      // the hidden pet lives in the corner; when it comes out it stands there
      if (p === 'hidden') {
        setOpen(false);
        place({ x: maxX(), y: GROUND });
      }
    },
    [maxX, place, setOpen],
  );
  const setTipsOn = (on: boolean) => {
    setTipsOnState(on);
    writeStore(TIPS_KEY, on ? 'on' : 'off');
    if (!on) setTip(null);
  };

  const applyAppearance = (next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
  };

  const applyUrl = () => {
    const url = urlDraft.trim();
    if (!url) return;
    if (!looksLikeImageUrl(url)) {
      toast('这看起来不像图片地址，请填以 .png / .jpg / .gif / .webp / .svg 结尾的直链', 'error');
      return;
    }
    applyAppearance({ ...appearance, kind: 'url', url });
    toast('形象已换成这个网址的图片', 'success');
  };

  const errorDetail = async (res: Response): Promise<string> => {
    const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
    return detail?.detail ?? `HTTP ${res.status}`;
  };

  /** 让服务端把已导入形象的背景去掉（动图逐帧处理，动画保留） */
  const stripStored = async (slot?: PoseSlot): Promise<{ animated: boolean }> => {
    const res = await fetch(`/api/pet/avatar/strip${slot ? `?slot=${slot}` : ''}`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as { animated: boolean };
  };

  const putFile = async (file: File, slot?: PoseSlot) => {
    const form = new FormData();
    form.append('file', file);
    const up = await fetch(`/api/pet/avatar${slot ? `?slot=${slot}` : ''}`, { method: 'POST', body: form });
    if (!up.ok) throw new Error(await errorDetail(up));
    // SVG is vector art: there is no background to strip
    return isSvg(file) ? null : stripStored(slot);
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const info = await putFile(file);
      applyAppearance({
        ...appearance,
        kind: 'upload',
        url: uploadedUrl(Date.now()),
        name: file.name || 'avatar.png',
      });
      toast(
        info ? (info.animated ? '形象已更新，背景已去掉（动画保留）' : '形象已更新，背景已去掉') : '形象已更新',
        'success',
      );
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const uploadPose = async (slot: PoseSlot, file: File | undefined) => {
    if (!file) return;
    setPoseBusy(slot);
    try {
      await putFile(file, slot);
      applyAppearance({ ...appearance, poses: { ...appearance.poses, [slot]: uploadedUrl(Date.now(), slot) } });
      toast(`「${POSE_SLOTS.find((p) => p.slot === slot)?.label}」的图已导入`, 'success');
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setPoseBusy(null);
    }
  };

  const clearPose = async (slot: PoseSlot) => {
    const poses = { ...appearance.poses };
    delete poses[slot];
    applyAppearance({ ...appearance, poses });
    try {
      await fetch(`/api/pet/avatar?slot=${slot}`, { method: 'DELETE' });
    } catch {
      /* replaced by the next import anyway */
    }
  };

  /** 对已经导入的形象再跑一次去背景（阈值不变，方便重试） */
  const stripCurrent = async () => {
    if (appearance.kind !== 'upload') return;
    setStripping(true);
    try {
      const info = await stripStored();
      applyAppearance({ ...appearance, url: uploadedUrl(Date.now()) });
      toast(info.animated ? '背景已去掉，动画保留' : '背景已去掉', 'success');
    } catch (e) {
      toast(`去背景失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setStripping(false);
    }
  };

  const resetAppearance = async () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, size: appearance.size });
    setUrlDraft('');
    try {
      await fetch('/api/pet/avatar', { method: 'DELETE' });
    } catch {
      /* the server copies are gone with the next upload anyway */
    }
  };

  const [vw, setVw] = useState(() => window.innerWidth);
  const [vh, setVh] = useState(() => window.innerHeight);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ offX: number; offY: number; startX: number; startY: number; lastX: number; moved: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());
  const simRef = useRef(0); // requestAnimationFrame id of the running simulation
  const stopSim = useCallback(() => {
    if (simRef.current) cancelAnimationFrame(simRef.current);
    simRef.current = 0;
  }, []);
  useEffect(() => stopSim, [stopSim]);

  // ---- where the pet stands ----
  useEffect(() => {
    place({ x: presenceRef.current === 'hidden' ? maxX() : Math.round(readRatio() * maxX()), y: GROUND });
    setPlaced(true);
  }, [place, maxX]);

  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
      setMenu(null);
      const x = presenceRef.current === 'hidden' ? maxX() : Math.min(posRef.current.x, maxX());
      place({ x, y: Math.min(posRef.current.y, window.innerHeight - sizeRef.current - GROUND) });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [place, maxX]);

  const wake = useCallback(() => {
    if (sleepRef.current) setSleep(null);
  }, [setSleep]);

  // ---- drag it around, let go and it falls back to the bottom edge ----
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setMenu(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (simRef.current) {
      // caught in mid-air
      stopSim();
      setFlying(false);
      place(posRef.current);
      if (rootRef.current) rootRef.current.style.transform = '';
      setLanding('');
    }
    tracker.current.reset();
    tracker.current.add(e.clientX, e.clientY);
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) {
      d.moved = true;
      setDragging(true);
      setWalking(false);
      setTip(null);
      wake();
      if (presenceRef.current === 'hidden') {
        setPresence('normal');
        toast('小页出来了（右键它可以再藏起来）', 'info');
      }
    }
    if (!d.moved) return;
    tracker.current.add(e.clientX, e.clientY);
    const dx = e.clientX - d.lastX;
    if (Math.abs(dx) > 2) {
      setHeading(dx < 0 ? 'left' : 'right');
      d.lastX = e.clientX;
    }
    const x = clamp(e.clientX - d.offX, 8, maxX());
    const top = clamp(e.clientY - d.offY, 8, window.innerHeight - sizeRef.current - GROUND);
    moveFast({ x, y: window.innerHeight - sizeRef.current - top });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    setDragging(false);
    if (!d.moved) {
      wake();
      setTip(null);
      setOpen((o) => !o);
      return;
    }
    const limit = maxX();
    const ph = physicsRef.current;
    place(posRef.current); // the drag moved the element directly: let the state catch up
    if (ph.bounce || ph.inertia) {
      const v = ph.inertia ? tracker.current.velocity() : { vx: 0, vy: 0 };
      throwPet(v.vx, v.vy);
      return;
    }
    writeStore(POS_KEY, JSON.stringify({ ratio: limit > 0 ? posRef.current.x / limit : 0 }));
    if (posRef.current.y > GROUND + 2) {
      setDropping(true);
      place({ x: posRef.current.x, y: GROUND });
      window.setTimeout(() => setDropping(false), 520);
    }
  };

  /** let go: gravity, bounces and the speed of the hand (physics.ts) */
  const throwPet = (vx: number, vy: number) => {
    const body: Body = { x: posRef.current.x, y: posRef.current.y, vx, vy };
    if (body.y <= GROUND + 1 && Math.hypot(vx, vy) < 40) {
      place({ x: body.x, y: GROUND });
      savePos();
      return;
    }
    stopSim();
    setFlying(true);
    let last = performance.now();
    let flip: 'a' | 'b' = 'a';
    const frame = (now: number) => {
      const world = {
        minX: 8,
        maxX: maxX(),
        ground: GROUND,
        ceiling: Math.max(GROUND, window.innerHeight - sizeRef.current - 8),
      };
      let dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      let res = { landed: 0, wall: 0, done: false };
      // small fixed steps: a fast fall never tunnels through the floor
      while (dt > 0) {
        const h = Math.min(dt, 1 / 120);
        const r = step(body, world, h, physicsRef.current);
        res = { landed: Math.max(res.landed, r.landed), wall: Math.max(res.wall, r.wall), done: r.done };
        dt -= h;
        if (r.done) break;
      }
      if (Math.abs(body.vx) > 60) setHeading(body.vx < 0 ? 'left' : 'right');
      if (res.landed > 260) {
        flip = flip === 'a' ? 'b' : 'a';
        setLanding(flip);
      }
      if (res.landed > 1500 || res.wall > 1100) {
        // a really hard landing or a wall at full speed: seeing stars
        burst('stars', 1800);
        speak(DIZZY[Math.floor(Math.random() * DIZZY.length)], 2200);
      }
      const airborne = body.y > GROUND + 1;
      moveFast({ x: body.x, y: body.y }, airborne ? Math.max(-16, Math.min(16, body.vx / 90)) : 0);
      if (res.done) {
        simRef.current = 0;
        place({ x: body.x, y: body.y });
        if (rootRef.current) rootRef.current.style.transform = '';
        setFlying(false);
        window.setTimeout(() => setLanding(''), 300);
        savePos();
        return;
      }
      simRef.current = requestAnimationFrame(frame);
    };
    simRef.current = requestAnimationFrame(frame);
  };

  const savePos = () => {
    const limit = maxX();
    writeStore(POS_KEY, JSON.stringify({ ratio: limit > 0 ? posRef.current.x / limit : 0 }));
  };

  // ---- wandering along the bottom edge ----
  const wander = useCallback(() => {
    const limit = maxX();
    const from = posRef.current.x;
    let to = 14 + Math.random() * Math.max(0, limit - 14);
    if (Math.abs(to - from) < 70) {
      to = from < limit / 2 ? Math.min(limit, from + 130 + Math.random() * 170) : Math.max(14, from - 130 - Math.random() * 170);
    }
    setHeading(to < from ? 'left' : 'right');
    setWalking(true);
    place({ x: to, y: GROUND });
    window.setTimeout(() => setWalking(false), 2450);
  }, [place, maxX]);

  const quietFocus = focusPhase === 'focus';
  const canWander = placed && !open && !dragging && !dropping && !flying && !menu && !tip && presence === 'normal' && !sleep && !quietFocus;
  useEffect(() => {
    if (!canWander) return;
    let timer = 0;
    const tick = () => {
      if (!document.hidden) wander();
      timer = window.setTimeout(tick, 12000 + Math.random() * 16000);
    };
    timer = window.setTimeout(tick, 7000 + Math.random() * 9000);
    return () => window.clearTimeout(timer);
  }, [canWander, wander]);

  const lastActivity = useRef(Date.now());
  const tipsOnRef = useRef(tipsOn);
  tipsOnRef.current = tipsOn;

  const pettedAt = useRef(0);
  const cheeredAt = useRef(0);
  const pageAt = useRef(Date.now());
  // ---- stroking: rub the pointer back and forth over it (no button pressed) ----
  const stroke = useRef({ x: 0, dir: 0, flips: 0, t0: 0, cool: 0 });
  const onStroke = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0 || dragRef.current || simRef.current || presenceRef.current !== 'normal') return;
    const st = stroke.current;
    const now = performance.now();
    if (now < st.cool) return;
    if (now - st.t0 > 1400) {
      st.flips = 0;
      st.dir = 0;
      st.t0 = now;
      st.x = e.clientX;
      return;
    }
    const dx = e.clientX - st.x;
    if (Math.abs(dx) < 6) return;
    const dir = dx > 0 ? 1 : -1;
    if (st.dir && dir !== st.dir) st.flips += 1;
    st.dir = dir;
    st.x = e.clientX;
    if (st.flips >= 3) {
      st.flips = 0;
      st.cool = now + 3500;
      pettedAt.current = Date.now();
      wake();
      burst('hearts');
      if (!openRef.current) speak(PURR[Math.floor(Math.random() * PURR.length)], 1800);
    }
  };

  // ---- a translation that finishes: it tells you (when its bubble is closed) ----
  const job = useTranslationStore((st) => st.job);
  const lastJob = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const prev = lastJob.current;
    lastJob.current = job ? { id: job.id, status: job.status } : null;
    if (!prev || (prev.status !== 'running' && prev.status !== 'pending')) return;
    const finished = !job || job.id !== prev.id || job.status === 'done';
    if (!finished || (job && job.id === prev.id && job.status !== 'done')) return;
    if (presenceRef.current === 'hidden' || openRef.current) return;
    wake();
    setLanding((l) => (l === 'a' ? 'b' : 'a')); // a little hop-squash
    window.setTimeout(() => setLanding(''), 320);
    cheeredAt.current = Date.now();
    if (presenceRef.current === 'normal') speak('翻译好了，可以看啦 ✓');
  }, [job, speak, wake]);

  // ---- a long stretch of reading: suggest a break (part of 主动提示) ----
  const readingSince = useRef(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now - lastActivity.current > 5 * 60_000) {
        readingSince.current = now; // away for a while: that was the break
        return;
      }
      if (now - readingSince.current < BREAK_AFTER_MIN * 60_000) return;
      readingSince.current = now;
      if (!tipsOnRef.current || presenceRef.current !== 'normal' || openRef.current || sleepRef.current) return;
      if (focusRef.current) return; // the focus timer has its own breaks
      speak(`已经读了 ${BREAK_AFTER_MIN} 分钟了，起来活动一下、看看远处吧`, 9000);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [speak]);

  // ---- study companion: a focus timer and a small reading log (pet/companion.ts) ----
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [stats, setStatsState] = useState<Stats>(() => loadStats());
  const statsRef = useRef(stats);
  const setFocus = useCallback((f: FocusState | null) => {
    focusRef.current = f;
    setFocusState(f);
    saveFocus(f);
    setClockNow(Date.now());
  }, []);
  const putStats = useCallback((next: Stats) => {
    statsRef.current = next;
    setStatsState(next);
    saveStats(next);
  }, []);
  const hop = useCallback(() => {
    setLanding((l) => (l === 'a' ? 'b' : 'a'));
    window.setTimeout(() => setLanding(''), 320);
  }, []);
  const beginFocus = useCallback(
    (minutes: number) => {
      setFocus(startFocus(minutes));
      setTip(null);
      wake();
      speak(`开始专注 ${minutes} 分钟，这段时间我不打扰你`, 3600);
    },
    [setFocus, speak, wake],
  );
  const focusOn = focus !== null;
  useEffect(() => {
    if (!focusOn) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      const f = focusRef.current;
      if (!f || now < f.endsAt) return;
      wake();
      hop();
      if (f.phase === 'focus') {
        putStats(addFocus(statsRef.current, now));
        setFocus(startBreak(now));
        readingSince.current = now + BREAK_MIN * 60_000; // the break counts as the rest
        cheeredAt.current = now;
        burst('stars');
        speak(`专注了 ${f.minutes} 分钟，歇 ${BREAK_MIN} 分钟吧`, 9000);
      } else {
        setFocus(null);
        speak('休息结束。右键我可以再开一轮专注', 9000);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focusOn, burst, hop, putStats, setFocus, speak, wake]);

  // a page counts as read after a few seconds on it; minutes count while the reader is active
  useEffect(() => {
    if (!docId) return;
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      const r = recordPage(statsRef.current, docId, currentPage);
      if (r.stats === statsRef.current) return;
      putStats(r.stats);
      const chatty = presenceRef.current === 'normal' && !focusRef.current && !openRef.current && tipsOnRef.current;
      if (r.milestone) {
        cheeredAt.current = Date.now();
        wake();
        burst('hearts');
        if (chatty) speak(`今天已经读了 ${r.milestone} 页！`, 5000);
      } else if (r.streakDay && chatty) {
        speak(`连续第 ${r.streakDay} 天来读书了，继续保持`, 5000);
      }
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [docId, currentPage, burst, putStats, speak, wake]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!useDocStore.getState().activeId || document.hidden) return;
      if (Date.now() - lastActivity.current > 90_000) return;
      putStats(addMinute(statsRef.current));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [putStats]);

  // ---- moods: now and then it does something on its own (pet/moods.ts) ----
  const [act, setAct] = useState<{ name: ActName; n: number } | null>(null);
  const [emote, setEmote] = useState<{ text: string; n: number } | null>(null);
  const lastAct = useRef<ActName | undefined>(undefined);
  const actTimers = useRef<number[]>([]);
  const currentMood = useCallback(
    (): Mood =>
      moodOf({
        hour: new Date().getHours(),
        idleMs: Date.now() - lastActivity.current,
        pagesToday: statsRef.current.pages.length,
        pettedAgo: Date.now() - pettedAt.current,
        cheeredAgo: Date.now() - cheeredAt.current,
        pageAgo: Date.now() - pageAt.current,
      }),
    [],
  );
  const [moodNow, setMoodNow] = useState<Mood>('calm');
  const express = useCallback(
    (asked: boolean) => {
      const mood = currentMood();
      setMoodNow(mood);
      const p = asked ? trick(Math.random, lastAct.current) : perform(mood, Math.random, lastAct.current);
      lastAct.current = p.act;
      for (const t of actTimers.current) window.clearTimeout(t);
      setAct((a) => ({ name: p.act, n: (a?.n ?? 0) + 1 }));
      setEmote((e) => ({ text: p.emote, n: (e?.n ?? 0) + 1 }));
      actTimers.current = [
        window.setTimeout(() => setAct(null), ACT_MS[p.act] + 60),
        window.setTimeout(() => setEmote(null), Math.max(1800, ACT_MS[p.act])),
      ];
      if (p.line && !openRef.current && tipsOnRef.current) speak(p.line, 3600);
    },
    [currentMood, speak],
  );
  useEffect(() => () => actTimers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    pageAt.current = Date.now();
  }, [docId, currentPage]);
  const canExpress = placed && !open && !dragging && !dropping && !flying && !menu && !tip && presence === 'normal' && !sleep && !quietFocus && !walking;
  const canExpressRef = useRef(canExpress);
  canExpressRef.current = canExpress;
  useEffect(() => {
    if (presence !== 'normal') return;
    let timer = 0;
    const tick = () => {
      if (!document.hidden && canExpressRef.current) express(false);
      timer = window.setTimeout(tick, 38_000 + Math.random() * 42_000);
    };
    timer = window.setTimeout(tick, 20_000 + Math.random() * 20_000);
    return () => window.clearTimeout(timer);
  }, [presence, express]);

  // ---- dozing off when nothing happens, waking on any activity ----
  useEffect(() => {
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      lastActivity.current = now;
      if (sleepRef.current === 'idle') setSleep(null);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    const timer = window.setInterval(() => {
      if (sleepRef.current || openRef.current || useChatStore.getState().streaming) return;
      if (Date.now() - lastActivity.current > SLEEP_AFTER_MS) {
        setSleep('idle');
        setTip(null);
      }
    }, 10000);
    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity);
      window.clearInterval(timer);
    };
  }, [setSleep]);

  // ---- ears up while the reader selects text (outside the bubble) ----
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      setListening(!!text && !el?.closest('.pet-bubble, .pet-tip, .pet-menu'));
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  useEffect(() => {
    if (!typing) return;
    const t = window.setTimeout(() => setTyping(false), 1400);
    return () => window.clearTimeout(t);
  }, [typing, input]);

  // ---- summoning: the sidebar button, 划词, a new question ----
  useEffect(() => {
    const onSummon = () => {
      setSleep(null);
      setTip(null);
      setOpen(true);
      setWalking(false);
    };
    window.addEventListener(PET_SUMMON_EVENT, onSummon);
    return () => window.removeEventListener(PET_SUMMON_EVENT, onSummon);
  }, [setOpen, setSleep]);

  useEffect(() => {
    if (docId) void loadFor(docId);
    else useChatStore.getState().reset();
  }, [docId, loadFor]);

  useEffect(() => {
    if (streaming) {
      setSleep(null);
      setTip(null);
      setOpen(true);
    }
  }, [streaming, setOpen, setSleep]);

  // an answer that finished while the bubble was closed: badge + hop until it is opened
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming && !openRef.current) {
      const all = useChatStore.getState().messages;
      const last = all[all.length - 1];
      if (last?.role === 'assistant' && !last.error) setUnread(true);
    }
    wasStreaming.current = streaming;
  }, [streaming]);
  useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
  useEffect(() => {
    setUnread(false);
  }, [docId]);

  useEffect(() => {
    if (notConfigured) setOpen(true);
  }, [notConfigured, setOpen]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, streaming]);

  // ---- Esc: close the menu, then the 换装 panel, then the bubble ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useViewStore.getState().settingsOpen) return;
      if (menu) {
        setMenu(null);
        hitRef.current?.focus();
        e.preventDefault();
        return;
      }
      if (tip) {
        setTip(null);
        e.preventDefault();
        return;
      }
      if (!openRef.current) return;
      // Esc in another field (the search box) belongs to that field
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]') && !t.closest('.pet-bubble')) return;
      e.preventDefault();
      if (picking) setPicking(false);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, tip, picking, setOpen]);

  // ---- right-click menu ----
  const openMenu = (x: number, y: number) => {
    setTip(null);
    setMoodNow(currentMood());
    setMenu({ x, y });
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('.pet-menu-item:not(:disabled)')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onScroll, { passive: true });
    window.addEventListener('blur', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onScroll);
      window.removeEventListener('blur', onScroll);
    };
  }, [menu]);

  // ---- offering help with the page the reader stopped on ----
  const tipped = useRef(new Set<string>());
  const lastTipAt = useRef(0);
  const turnedDown = useRef(0);
  useEffect(() => {
    setTip((t) => (t && t.page !== currentPage ? null : t));
    if (!docId || !tipsOn || presence !== 'normal' || focusPhase === 'focus') return;
    const key = `${docId}:${currentPage}`;
    if (tipped.current.has(key)) return;
    const timer = window.setTimeout(() => {
      const chat = useChatStore.getState();
      if (openRef.current || chat.streaming || chat.notConfigured || sleepRef.current || document.hidden) return;
      if (Date.now() - lastTipAt.current < TIP_COOLDOWN_MS * (1 + turnedDown.current)) return;
      const page = useTranslationStore.getState().pages[currentPage];
      if (!page?.loaded) return;
      tipped.current.add(key);
      const offer = offerFor(currentPage, page.blocks);
      if (!offer) return;
      lastTipAt.current = Date.now();
      setTip({ ...offer, page: currentPage });
    }, TIP_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [docId, currentPage, tipsOn, presence, focusPhase]);
  useEffect(() => {
    if (!tip) return;
    const t = window.setTimeout(() => setTip(null), TIP_SHOW_MS);
    return () => window.clearTimeout(t);
  }, [tip]);

  const acceptTip = () => {
    if (!tip) return;
    turnedDown.current = 0;
    const { ask, mode, page } = tip;
    setTip(null);
    setOpen(true);
    void send(ask, page, { mode });
  };
  const declineTip = () => {
    turnedDown.current = Math.min(turnedDown.current + 1, 4);
    setTip(null);
  };

  // ---- hidden in the corner: it comes out whenever the bubble opens ----
  const tucked = presence === 'hidden' && !open && !dragging && !menu;
  const wasTucked = useRef(tucked);
  useEffect(() => {
    if (wasTucked.current === tucked) return;
    wasTucked.current = tucked;
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), 480);
    return () => window.clearTimeout(t);
  }, [tucked]);
  const shown = tucked
    ? { x: maxX(), y: -Math.round(size * 0.48) }
    : dragging || flying
      ? posRef.current // moved directly in the DOM (moveFast): never render an older position over it
      : pos;

  const mood: PetMood = dragging || dropping || flying
    ? 'idle'
    : streaming
      ? streamingText
        ? 'talk'
        : 'think'
      : sleep
        ? 'sleep'
        : walking
          ? 'walk'
          : listening || typing
            ? 'listen'
            : 'idle';

  const faces: Facing = appearance.faces;
  const flip = faces !== 'front' && heading !== faces;
  const poseSrc = mood !== 'idle' ? appearance.poses[mood as PoseSlot] : undefined;
  const preload = Object.values(appearance.poses).filter((u): u is string => !!u);
  const badge: PetBadge = open ? null : notConfigured ? 'alert' : unread ? 'unread' : null;

  // ---- bubble geometry: above the pet, nudged back inside the window ----
  const bubbleW = Math.min(BUBBLE_MAX_W, Math.max(260, vw - 24));
  const bubbleLeft = clamp(pos.x + size / 2 - bubbleW / 2, 10, Math.max(10, vw - bubbleW - 10));
  const bubbleBottom = clamp(pos.y + size + 12, 14, Math.max(14, vh - 200));
  const bubbleMaxH = Math.max(150, Math.min(460, vh - bubbleBottom - 20));
  const tailX = clamp(pos.x + size / 2 - bubbleLeft, 18, bubbleW - 18);

  const tipW = Math.min(250, vw - 20);
  const tipLeft = clamp(shown.x + size / 2 - tipW / 2, 10, Math.max(10, vw - tipW - 10));
  // the little tag over its head: the focus countdown, or how far a translation has got
  const jobRunning = !!job && (job.status === 'running' || job.status === 'pending') && job.total > 0;
  const pill = tucked
    ? null
    : focus
      ? { kind: focus.phase, text: `${focus.phase === 'focus' ? '专注' : '休息'} ${clock(focus.endsAt - clockNow)}` }
      : jobRunning
        ? { kind: 'job', text: `翻译 ${Math.min(99, Math.floor((job.done / job.total) * 100))}%` }
        : null;
  const tipBottom = clamp(shown.y + size + (pill ? 30 : 10), 14, Math.max(14, vh - 120));

  const MENU_W = 200;
  const MENU_H = 445;
  const menuLeft = menu ? clamp(menu.x, 8, Math.max(8, vw - MENU_W - 8)) : 0;
  const menuTop = menu ? clamp(menu.y - MENU_H, 8, Math.max(8, vh - MENU_H - 8)) : 0;

  const doSend = async (text: string) => {
    const msg = text.trim();
    if (!msg || streaming || !docId) return;
    setInput('');
    setHistory(false);
    await send(msg, useViewStore.getState().currentPage);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'success');
    } catch {
      toast('复制失败：浏览器不允许访问剪贴板', 'error');
    }
  };

  const shownMessages = history ? messages : messages.slice(-2);
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  const canAsk = !!docId && !streaming && !notConfigured;

  const menuAction = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  const setupCard = (
    <div className="pet-setup">
      <p>小页还没接上 AI。阅读助手和翻译分开配置：可以给它单独用一个更擅长讲解的模型，用量也分开统计。</p>
      <div className="pet-setup-actions">
        <button type="button" className="btn btn-primary btn-xs" onClick={() => openSettings('assistant')}>
          去配置
        </button>
        <button
          type="button"
          className="btn btn-xs"
          title="把翻译 API 的服务商、Key、模型复制一份作为阅读助手的独立配置"
          onClick={() => void copyFromTranslation().then(() => refreshSummary())}
        >
          复制翻译 API 的配置
        </button>
      </div>
    </div>
  );

  const label = sleep ? '小页 · 在睡觉，点一下叫醒' : unread ? '小页 · 有一条新回答，点击查看' : '小页 · 阅读助手，点击展开对话，右键更多';

  return (
    <>
      <div
        className={[
          'pet',
          walking ? 'is-walking' : '',
          dragging ? 'is-dragging' : '',
          dropping ? 'is-dropping' : '',
          flying ? 'is-flying' : '',
          landing ? `is-land-${landing}` : '',
          act && !dragging && !flying ? `is-act-${act.name}` : '',
          presence === 'quiet' && !open ? 'is-quiet' : '',
          tucked ? 'is-tucked' : '',
          settling && !tucked ? 'is-untucking' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          left: shown.x,
          bottom: shown.y,
          width: size,
          height: size,
          visibility: placed ? 'visible' : 'hidden',
        }}
        ref={rootRef}
        onPointerMove={onStroke}
      >
        {pill && (
          <div className={`pet-pill is-${pill.kind}`} role={pill.kind === 'job' ? undefined : 'timer'} aria-label={pill.text}>
            {pill.text}
          </div>
        )}
        {emote && !dragging && !flying && (
          <span className="pet-emote" key={emote.n} aria-hidden="true">
            {emote.text}
          </span>
        )}
        {fx && (
          <div className={`pet-fx is-${fx.kind}`} key={fx.n} aria-hidden="true">
            {(fx.kind === 'hearts' ? ['♥', '♥', '♥'] : ['✦', '✧', '✦']).map((c, i) => (
              <span key={i} style={{ ['--i' as string]: i }}>
                {c}
              </span>
            ))}
          </div>
        )}
        <div
          ref={hitRef}
          className="pet-hit"
          role="button"
          tabIndex={0}
          title={label}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e.clientX, e.clientY);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              wake();
              setOpen((o) => !o);
            } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left + r.width / 2, r.top);
            }
          }}
        >
          <PetBody
            src={appearance.url}
            poseSrc={poseSrc}
            preload={preload}
            mood={mood}
            dragging={dragging || (flying && !landing)}
            dropping={dropping}
            badge={badge}
            flip={flip}
          />
        </div>
      </div>

      {say && !open && !tucked && (
        <div className="pet-tip pet-say" role="status" style={{ left: clamp(shown.x + size / 2, 70, Math.max(70, vw - 70)), bottom: tipBottom, maxWidth: tipW }}>
          {say}
        </div>
      )}

      {tip && !say && !open && (
        <div className="pet-tip" role="status" style={{ left: tipLeft, bottom: tipBottom, width: tipW }}>
          <div>{tip.text}</div>
          <div className="pet-tip-actions">
            <button type="button" className="pet-chip-btn primary" onClick={acceptTip}>
              好啊
            </button>
            <button type="button" className="pet-chip-btn" onClick={declineTip}>
              不用了
            </button>
            <button type="button" className="pet-tip-off" onClick={() => setTipsOn(false)} title="以后不再主动提示（右键小页可以重新打开）">
              别再提示
            </button>
          </div>
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="pet-menu"
          role="menu"
          aria-label="小页"
          style={{ left: menuLeft, top: menuTop, width: MENU_W }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.pet-menu-item:not(:disabled)') ?? []);
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          <div className="pet-menu-stats" title="读过的页数（停留几秒才算）、阅读时间、连续阅读的天数——只记在这个浏览器里">
            {summary(stats)}
            <span className="pet-menu-mood">心情：{MOOD_NAME[moodNow]}</span>
          </div>
          <button type="button" role="menuitem" className="pet-menu-item" onClick={menuAction(() => { wake(); setOpen((o) => !o); })}>
            <span className="pet-menu-check" />
            {open ? '收起对话' : '打开对话'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu-item"
            disabled={!canAsk}
            onClick={menuAction(() => void send('总结本页', useViewStore.getState().currentPage, { mode: 'page' }))}
          >
            <span className="pet-menu-check" />
            总结本页
            <span className="pet-menu-note">第 {currentPage} 页</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu-item"
            disabled={!canAsk}
            onClick={menuAction(() => void send('本页自测', useViewStore.getState().currentPage, { mode: 'quiz' }))}
          >
            <span className="pet-menu-check" />
            本页自测
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu-item"
            onClick={menuAction(() => {
              wake();
              setOpen(true);
              setPicking(true);
            })}
          >
            <span className="pet-menu-check" />
            换装…
          </button>
          <div className="pet-menu-sep" role="separator" />
          {(
            [
              ['normal', '正常', '会走动'],
              ['quiet', '安静', '不走动不搭话'],
              ['hidden', '藏到角落', '划词时出来'],
            ] as const
          ).map(([p, text, note]) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={presence === p}
              className="pet-menu-item"
              onClick={menuAction(() => setPresence(p))}
            >
              <span className="pet-menu-check">{presence === p ? '●' : ''}</span>
              {text}
              <span className="pet-menu-note">{note}</span>
            </button>
          ))}
          <div className="pet-menu-sep" role="separator" />
          {focus ? (
            <button
              type="button"
              role="menuitem"
              className="pet-menu-item"
              onClick={menuAction(() => {
                setFocus(null);
                speak(focus.phase === 'focus' ? '专注结束了' : '好，继续读吧', 2400);
              })}
            >
              <span className="pet-menu-check" />
              {focus.phase === 'focus' ? '结束专注' : '跳过休息'}
              <span className="pet-menu-note">还剩 {clock(focus.endsAt - clockNow)}</span>
            </button>
          ) : (
            <div className="pet-menu-row" role="group" aria-label="专注计时" title={`专注期间小页不走动、不搭话，时间到了提醒你休息 ${BREAK_MIN} 分钟`}>
              <span className="pet-menu-row-label">专注</span>
              {FOCUS_CHOICES.map((m) => (
                <button key={m} type="button" role="menuitem" className="pet-menu-item pet-menu-chip" aria-label={`专注 ${m} 分钟`} onClick={menuAction(() => beginFocus(m))}>
                  {m} 分
                </button>
              ))}
            </div>
          )}
          <div className="pet-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={tipsOn}
            className="pet-menu-item"
            disabled={presence !== 'normal'}
            title={presence !== 'normal' ? '安静和藏起来的时候不会主动提示' : '在一页停留一会儿，看到公式、表格或大段文字时问你要不要讲讲'}
            onClick={menuAction(() => setTipsOn(!tipsOn))}
          >
            <span className="pet-menu-check">{tipsOn ? '✓' : ''}</span>
            主动提示
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={physics.bounce || physics.inertia}
            className="pet-menu-item"
            title="拖到高处松手会掉下来弹几下，甩出去有惯性（设置 → 界面 → 桌宠 可以分开开关）"
            onClick={menuAction(() => {
              const on = !(physics.bounce || physics.inertia);
              savePhysics({ bounce: on, inertia: on });
            })}
          >
            <span className="pet-menu-check">{physics.bounce || physics.inertia ? '✓' : ''}</span>
            物理效果
            <span className="pet-menu-note">弹跳、惯性</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu-item"
            onClick={menuAction(() => {
              if (sleep) setSleep(null);
              else {
                setOpen(false);
                setTip(null);
                setSleep('manual');
              }
            })}
          >
            <span className="pet-menu-check" />
            {sleep ? '叫醒它' : '让它睡一会'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pet-menu-item"
            disabled={!!sleep}
            onClick={menuAction(() => {
              wake();
              window.setTimeout(() => express(true), 120);
            })}
          >
            <span className="pet-menu-check" />
            表演一个
            <span className="pet-menu-note">翻跟头、转圈…</span>
          </button>
        </div>
      )}

      {open && (
        <>
          <div
            className="pet-tail"
            style={{ left: bubbleLeft + tailX - 6, bottom: bubbleBottom - 6 }}
            aria-hidden="true"
          />
          <div
            className="pet-bubble"
            role="dialog"
            aria-label="小页 · 阅读助手"
            style={{
              left: bubbleLeft,
              bottom: bubbleBottom,
              width: bubbleW,
              maxHeight: bubbleMaxH,
            }}
          >
          <div className="pet-bubble-head">
            <span className="pet-name">小页</span>
            {docTitle && (
              <span className="pet-chip" title={docTitle}>
                {short(docTitle)}
              </span>
            )}
            <span className="pet-chip">第 {currentPage} 页</span>
            <span className="pet-head-spacer" />
            <button
              type="button"
              className={`icon-btn ${picking ? 'active' : ''}`}
              title="换装"
              aria-label="换装"
              aria-pressed={picking}
              onClick={() => setPicking((p) => !p)}
            >
              <Icon name="palette" size={14} />
            </button>
            <button
              type="button"
              className={`icon-btn ${history ? 'active' : ''}`}
              title={history ? '只看最近一问一答' : '看完整对话记录'}
              aria-pressed={history}
              onClick={() => setHistory((h) => !h)}
            >
              <Icon name="rows" size={14} />
            </button>
            <button type="button" className="icon-btn" title="收起来（Esc）" aria-label="收起对话" onClick={() => setOpen(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>

          <div className="pet-bubble-body" ref={bodyRef}>
            {picking ? (
              <>
                <div className="pet-appearance">
                  <div className="pet-field">
                    <span className="pet-field-label">图片网址</span>
                    <div className="pet-field-row">
                      <input
                        className="pet-text"
                        placeholder="https://…/cat.gif"
                        value={urlDraft}
                        spellCheck={false}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') applyUrl();
                        }}
                      />
                      <button type="button" className="pet-chip-btn" disabled={!urlDraft.trim()} onClick={applyUrl}>
                        应用
                      </button>
                    </div>
                  </div>

                  <div className="pet-field">
                    <span className="pet-field-label">大小 · {size}px</span>
                    <input
                      className="pet-range"
                      type="range"
                      min={PET_SIZE_MIN}
                      max={PET_SIZE_MAX}
                      step={4}
                      value={size}
                      onChange={(e) => applyAppearance({ ...appearance, size: Number(e.target.value) })}
                    />
                  </div>

                  <div className="pet-field">
                    <span className="pet-field-label">原图里它朝哪边（走路时会按方向转身；走起来像倒着走就改一下）</span>
                    <div className="pet-seg" role="radiogroup" aria-label="原图朝向">
                      {(
                        [
                          ['left', '朝左'],
                          ['right', '朝右'],
                          ['front', '正面，不转身'],
                        ] as const
                      ).map(([f, text]) => (
                        <button
                          key={f}
                          type="button"
                          role="radio"
                          aria-checked={faces === f}
                          onClick={() => applyAppearance({ ...appearance, faces: f })}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="pet-field-row">
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={uploading}
                      onClick={() => fileRef.current?.click()}
                    >
                      {uploading ? '导入中…' : '选择本地图片 / GIF'}
                    </button>
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={appearance.kind !== 'upload' || stripping}
                      title={
                        appearance.kind === 'upload'
                          ? '把和边框连通的那片背景挖掉，做成透明底'
                          : '只对「选择本地图片」导入的图可用'
                      }
                      onClick={() => void stripCurrent()}
                    >
                      {stripping ? '处理中…' : '去掉背景'}
                    </button>
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={appearance.kind === 'builtin' && Object.keys(appearance.poses).length === 0}
                      onClick={() => void resetAppearance()}
                    >
                      换回小页
                    </button>
                    <input
                      ref={fileRef}
                      className="pet-import"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void uploadFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </div>

                  {appearance.kind === 'builtin' && (
                    <div className="pet-picker-hint">现在用的是附带的小页。</div>
                  )}
                  {appearance.kind === 'upload' && (
                    <div className="pet-picker-hint">
                      已保存到本机 data\pet\。导入时已经自动去过一次背景，边上有残留就再点一次「去掉背景」。
                    </div>
                  )}
                  {appearance.kind === 'url' && (
                    <div className="pet-picker-hint">
                      直接引用外部地址，图片换了这边跟着变；外部图片没法在这里去背景，需要透明底请下载后导入。
                    </div>
                  )}

                  <div className="pet-field">
                    <span className="pet-field-label">动作图（可选）：每个动作单独一张，没有的就用上面的形象</span>
                    <div className="pet-poses">
                      {POSE_SLOTS.map(({ slot, label: poseLabel, hint }) => {
                        const u = appearance.poses[slot];
                        return (
                          <div key={slot} className="pet-pose">
                            <span className="pet-pose-thumb">{u ? <img src={u} alt="" /> : '—'}</span>
                            <span className="pet-pose-label">
                              {poseLabel}
                              <small>{hint}</small>
                            </span>
                            <button
                              type="button"
                              className="pet-chip-btn"
                              disabled={poseBusy !== null}
                              onClick={() => {
                                poseTarget.current = slot;
                                poseFileRef.current?.click();
                              }}
                            >
                              {poseBusy === slot ? '导入中…' : u ? '更换' : '导入'}
                            </button>
                            {u && (
                              <button type="button" className="pet-chip-btn" onClick={() => void clearPose(slot)}>
                                清除
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <input
                      ref={poseFileRef}
                      className="pet-import"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const slot = poseTarget.current;
                        if (slot) void uploadPose(slot, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>

                <div className="pet-picker-bar">
                  <span className="pet-picker-hint">
                    程序不内置任何角色。透明底的 PNG / 动态 GIF 效果最好。免费素材可以看
                    <a href="https://www.dicebear.com/styles/" target="_blank" rel="noreferrer">
                      DiceBear
                    </a>
                    、
                    <a href="https://opengameart.org/" target="_blank" rel="noreferrer">
                      OpenGameArt
                    </a>
                    、
                    <a href="https://kenney.nl/assets" target="_blank" rel="noreferrer">
                      Kenney
                    </a>
                    。
                  </span>
                </div>
              </>
            ) : notConfigured ? (
              setupCard
            ) : (
              <>
                {messages.length === 0 &&
                  (loading ? (
                    <div className="pet-empty">正在读这份文档…</div>
                  ) : summaryMd ? (
                    <div className="pet-msg-a">
                      <Markdown text={summaryMd} onPage={requestPageNav} />
                    </div>
                  ) : (
                    <div className="pet-empty">
                      在原文或译文里<strong>选中一段文字</strong>，小页会解释、讲公式或翻译；也可以直接问我。
                    </div>
                  ))}

                {messages.length === 0 && questions.length > 0 && (
                  <div className="pet-chips" style={{ padding: 0 }}>
                    {questions.slice(0, 4).map((q) => (
                      <button key={q} type="button" className="pet-chip-btn" disabled={streaming} onClick={() => void doSend(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                )}

                {shownMessages.map((m, i) => {
                  const index = messages.length - shownMessages.length + i;
                  if (m.role === 'user') {
                    const { quote, text } = splitQuote(m.content);
                    return (
                      <div key={index} className="pet-msg">
                        <div className="pet-msg-q">
                          {quote && <span className="pet-quote">{quote.length > 220 ? `${quote.slice(0, 220)}…` : quote}</span>}
                          {text}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={index} className="pet-msg">
                      <div className={`pet-msg-a ${m.error ? 'error' : ''}`}>
                        <Markdown text={m.content} onPage={requestPageNav} />
                      </div>
                      {!m.error && (
                        <div className="pet-foot-row">
                          {m.sources && m.sources.length > 0 && (
                            <span className="pet-sources">
                              参考
                              {m.sources.map((p) => (
                                <button key={p} type="button" className="page-ref" onClick={() => requestPageNav(p)}>
                                  p{p}
                                </button>
                              ))}
                            </span>
                          )}
                          <span className="pet-foot-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="复制回答"
                              aria-label="复制回答"
                              onClick={() => void copy(m.content)}
                            >
                              <Icon name="copy" size={12} />
                            </button>
                            {index === lastAssistant && (
                              <button
                                type="button"
                                className="icon-btn"
                                title="重新生成"
                                aria-label="重新生成"
                                disabled={streaming}
                                onClick={() => void regenerate(useViewStore.getState().currentPage)}
                              >
                                <Icon name="refresh" size={12} />
                              </button>
                            )}
                          </span>
                        </div>
                      )}
                      {m.error && (
                        <div className="pet-foot-row">
                          <span className="pet-foot-actions">
                            <button type="button" className="btn btn-xs" onClick={() => void regenerate(useViewStore.getState().currentPage)}>
                              重试
                            </button>
                            <button type="button" className="btn btn-xs" onClick={() => openSettings('assistant')}>
                              检查设置
                            </button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}

                {streaming && (
                  <div className="pet-msg">
                    {streamingReasoning && (
                      <details className="pet-thinking" open={!streamingText}>
                        <summary>{streamingText ? `思考过程（${streamingReasoning.length} 字）` : '正在想…'}</summary>
                        <div className="pet-thinking-text">{streamingReasoning}</div>
                      </details>
                    )}
                    <div className="pet-msg-a">
                      {streamingText ? (
                        <>
                          <Markdown text={streamingText} onPage={requestPageNav} />
                          <span className="pet-caret" />
                        </>
                      ) : (
                        <span className="pet-empty">正在想…</span>
                      )}
                    </div>
                    {streamingSources.length > 0 && (
                      <div className="pet-foot-row">参考 {streamingSources.map((p) => `p${p}`).join(' ')}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {!notConfigured && !picking && (
            <div className="pet-chips">
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || !docId}
                onClick={() => void send('总结本页', currentPage, { mode: 'page' })}
              >
                总结本页
              </button>
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || !docId}
                onClick={() => void send('本页自测', currentPage, { mode: 'quiz' })}
              >
                本页自测
              </button>
              <button type="button" className="pet-chip-btn" disabled={loading || !docId} onClick={() => void refreshSummary()}>
                重读总结
              </button>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || messages.length === 0}
                onClick={() => void clear()}
              >
                清空
              </button>
            </div>
          )}

          {!notConfigured && !picking && (
            <div className="pet-input-row">
              <textarea
                className="pet-input"
                rows={1}
                placeholder="问我这份文档…（Enter 发送，Shift+Enter 换行）"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setTyping(true);
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(e) => {
                  // Enter while an IME (拼音) is composing only confirms the candidate
                  if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    void doSend(input);
                  }
                }}
              />
              <div className="pet-send">
                {streaming ? (
                  <button type="button" className="btn btn-sm" onClick={stop} title="停止生成">
                    <Icon name="stop" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!input.trim() || !docId}
                    title="发送"
                    aria-label="发送"
                    onClick={() => void doSend(input)}
                  >
                    <Icon name="send" size={12} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        </>
      )}
    </>
  );
}
