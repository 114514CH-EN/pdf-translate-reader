import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api/client';
import { useSettingsStore } from '../stores/settings';
import { useViewStore } from '../stores/view';
import type { Block, ImageTranslation } from '../types';

/**
 * A picture of the page in the translated view.
 *
 * The page background already shows the picture itself. With 「翻译图片文字」 switched
 * on (设置 → 翻译), pointing at a picture offers to translate the text inside it —
 * one picture at a time, the reader decides which. The translated copy has the
 * same size and place and is laid over the original; it can be compared with the
 * original, redone, or removed again.
 */
export default function ImageBlock({
  block,
  docId,
  pageNo,
  className,
  style,
  hasBackground,
  onMouseEnter,
  onMouseLeave,
}: {
  block: Block;
  docId: string;
  pageNo: number;
  className: string;
  style: CSSProperties;
  hasBackground: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const enabled = useSettingsStore((s) => s.settings.ui?.imageTranslate === true);
  const toast = useViewStore((s) => s.toast);
  const [tr, setTr] = useState<ImageTranslation | null>(block.image_tr ?? null);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => setTr(block.image_tr ?? null), [block.image_tr]);

  const translate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.translateImage(docId, pageNo, block.id);
      setTr(r);
      setShowOriginal(false);
      if (!r?.url) {
        toast(r && r.found > 0 ? '这张图里的文字不需要翻译（只有数字、符号或已是译文语言）' : '这张图里没有识别到文字', 'info');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteImageTranslation(docId, pageNo, block.id);
      setTr(null);
      setShowOriginal(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const big = Number(style.width) >= 70 && Number(style.height) >= 36;
  const translated = !!tr?.url;

  return (
    <div
      className={`${className}${busy ? ' is-busy' : ''}`}
      data-block-id={block.id}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {!hasBackground && block.meta?.file && (
        <img src={api.imageUrl(docId, block.meta.file)} alt="插图" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      )}
      {translated && !showOriginal && (
        <img className="img-tr" src={tr!.url!} alt="文字已翻译的插图" draggable={false} />
      )}
      {busy && (
        <div className="img-tr-busy" role="status">
          <span className="img-tr-spinner" aria-hidden="true" />
          正在识别并翻译图片文字…
        </div>
      )}
      {enabled && big && !busy && (
        <div className="img-tr-actions">
          {!translated && (
            <button type="button" className="img-tr-btn" onClick={() => void translate()} title="识别这张图里的文字并翻译，画回原位置">
              翻译图片文字
            </button>
          )}
          {translated && (
            <>
              <button type="button" className="img-tr-btn" onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? '看译图' : '看原图'}
              </button>
              <button type="button" className="img-tr-btn" onClick={() => void translate()} title="重新识别并翻译这张图">
                重新翻译
              </button>
              <button type="button" className="img-tr-btn" onClick={() => void restore()} title="删除译图，恢复原图">
                恢复原图
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
