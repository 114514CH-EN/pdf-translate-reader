/**
 * 桌宠的身体 = 读者自己给的一张图（png / gif / webp / svg 都行），透明背景的
 * 抠图直接贴在屏幕上，下面一层投影。程序不内置任何角色形象。
 *
 * 各动作的图全部常驻在 DOM 里，只切换显示哪一张：换动作时不会闪一下空白，
 * 动图也不会每次从第一帧重新开始。
 */
import { useEffect, useState } from 'react';

export type PetMood = 'idle' | 'walk' | 'think' | 'talk' | 'listen' | 'sleep';

export type PetBadge = 'alert' | 'unread' | null;

export function PetBody({
  src,
  poseSrc,
  preload = [],
  mood,
  dragging,
  dropping,
  badge,
  flip,
  still,
}: {
  /** 主形象地址；没有时显示空槽位 */
  src?: string;
  /** 当前动作单独的图（没有就用主形象） */
  poseSrc?: string;
  /** 其它动作的图：先加载好，切换时不闪 */
  preload?: string[];
  mood: PetMood;
  dragging: boolean;
  dropping: boolean;
  /** alert：需要处理（比如阅读助手还没配置）；unread：有一条没看的回答 */
  badge?: PetBadge;
  /** 水平翻转（往另一边走） */
  flip?: boolean;
  /** 面板里的小预览：不动 */
  still?: boolean;
}) {
  // a dead link or a deleted upload falls back to the main picture, then to the empty slot
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  useEffect(() => setBroken(new Set()), [src, poseSrc]);
  const ok = (u?: string) => (u && !broken.has(u) ? u : undefined);

  const state = dragging ? 'drag' : dropping ? 'drop' : mood;
  // a pose with its own picture plays that picture instead of the generic wobble
  const pose = dragging || dropping ? undefined : ok(poseSrc);
  const image = pose ?? ok(src);
  const all = Array.from(new Set([src, poseSrc, ...preload].filter((u): u is string => !!u && !broken.has(u))));

  return (
    <div
      className={[
        'pet-body',
        `is-${state}`,
        still ? 'is-still' : '',
        image ? '' : 'is-empty',
        pose ? 'has-pose' : '',
        badge === 'unread' ? 'has-unread' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="pet-shadow" aria-hidden="true" />
      <div className="pet-art">
        {image ? (
          all.map((u) => (
            <img
              key={u}
              className={`pet-img ${flip ? 'is-flipped' : ''}`}
              src={u}
              alt=""
              draggable={false}
              hidden={u !== image}
              onError={() => setBroken((b) => new Set(b).add(u))}
            />
          ))
        ) : (
          <span className="pet-slot" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        )}
      </div>
      {badge === 'alert' && <span className="pet-alert" aria-hidden="true">!</span>}
      {badge === 'unread' && <span className="pet-unread" aria-hidden="true" />}
      {mood === 'think' && !dragging && !still && (
        <span className="pet-think" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {mood === 'sleep' && !dragging && !still && (
        <span className="pet-zzz" aria-hidden="true">
          <i>z</i>
          <i>z</i>
          <i>Z</i>
        </span>
      )}
      {mood === 'listen' && !dragging && !still && <span className="pet-ear" aria-hidden="true">♪</span>}
    </div>
  );
}
