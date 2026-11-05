/**
 * 桌宠的身体 = 读者自己给的一张图（png / gif / webp / svg 都行），透明背景的
 * 抠图直接贴在屏幕上，下面一层投影。程序不内置任何角色形象。
 */
import { useEffect, useState } from 'react';

export type PetMood = 'idle' | 'walk' | 'think' | 'talk' | 'listen' | 'sleep';

export function PetBody({
  src,
  mood,
  dragging,
  dropping,
  alert,
  still,
}: {
  /** 形象图片地址；没有时显示空槽位 */
  src?: string;
  mood: PetMood;
  dragging: boolean;
  dropping: boolean;
  /** unread / needs attention (e.g. the assistant is not configured) */
  alert: boolean;
  /** 面板里的小预览：不动 */
  still?: boolean;
}) {
  // a dead link or a deleted upload falls back to the empty slot instead of a broken icon
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  const state = dragging ? 'drag' : dropping ? 'drop' : mood;
  const image = src && !broken ? src : undefined;
  return (
    <div className={`pet-body is-${state}${still ? ' is-still' : ''}${image ? '' : ' is-empty'}`}>
      <div className="pet-shadow" aria-hidden="true" />
      <div className="pet-art">
        {image ? (
          <img className="pet-img" src={image} alt="" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <span className="pet-slot" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        )}
      </div>
      {alert && <span className="pet-alert" aria-hidden="true">!</span>}
      {mood === 'think' && !dragging && !still && (
        <span className="pet-think" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {mood === 'sleep' && !dragging && !still && <span className="pet-zzz" aria-hidden="true">z</span>}
    </div>
  );
}
