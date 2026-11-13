import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { katexNow, loadKatex, texHtml, texPng } from '../lib/katex';
import { findBlock, useEditStore } from '../stores/edit';
import { useViewStore } from '../stores/view';
import { Icon } from './Icon';

/** Things people type all the time; `|` is where the caret lands. */
const SNIPPETS: { label: string; tex: string; hint: string }[] = [
  { label: 'a/b', tex: '\\frac{|}{}', hint: '分数' },
  { label: 'x²', tex: '^{|}', hint: '上标' },
  { label: 'xᵢ', tex: '_{|}', hint: '下标' },
  { label: '√', tex: '\\sqrt{|}', hint: '根号' },
  { label: '∑', tex: '\\sum_{|}^{}', hint: '求和' },
  { label: '∫', tex: '\\int_{|}^{}', hint: '积分' },
  { label: '∂', tex: '\\partial ', hint: '偏导' },
  { label: '∞', tex: '\\infty ', hint: '无穷' },
  { label: '×', tex: '\\times ', hint: '乘号' },
  { label: '≈', tex: '\\approx ', hint: '约等于' },
  { label: '≤', tex: '\\le ', hint: '小于等于' },
  { label: 'π', tex: '\\pi ', hint: 'pi' },
  { label: 'ω', tex: '\\omega ', hint: 'omega' },
  { label: 'τ', tex: '\\tau ', hint: 'tau' },
  { label: '[ ]', tex: '\\begin{bmatrix} | & \\\\ & \\end{bmatrix}', hint: '矩阵' },
  { label: '(1)', tex: '\\tag{|}', hint: '公式编号' },
];

/**
 * 公式编辑: in edit mode, clicking a formula opens this panel. The formula is written
 * in LaTeX with a live preview; saving puts it in the place of the original (which
 * can always be brought back). It is one step of the edit history like any other.
 */
export function FormulaEditor() {
  const target = useEditStore((s) => s.formula);
  const close = useEditStore((s) => s.closeFormula);
  const toast = useViewStore((s) => s.toast);
  const block = target ? findBlock(target.blockId) : undefined;
  const current = (target?.side === 'src' ? block?.src_edit?.text : block?.translation) ?? '';
  const [tex, setTex] = useState(current);
  const [ready, setReady] = useState(katexNow() !== null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTex(current);
    if (target) window.setTimeout(() => area.current?.focus(), 30);
    // a different formula was opened: start from what it holds now
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.blockId, target?.side]);
  useEffect(() => {
    if (target && !ready) void loadKatex().then(() => setReady(true));
  }, [target, ready]);
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [target, close]);

  const preview = useMemo(() => {
    const k = katexNow();
    if (!ready || !k || !tex.trim()) return { html: '', error: '' };
    try {
      return { html: texHtml(k, tex, { strict: true }), error: '' };
    } catch (e) {
      return { html: '', error: (e instanceof Error ? e.message : String(e)).replace(/^KaTeX parse error:\s*/, '') };
    }
  }, [tex, ready]);

  if (!target || !block) return null;

  const insert = (snippet: string) => {
    const el = area.current;
    if (!el) return;
    const at = snippet.indexOf('|');
    const text = snippet.replace('|', '');
    const start = el.selectionStart ?? tex.length;
    const end = el.selectionEnd ?? tex.length;
    setTex(tex.slice(0, start) + text + tex.slice(end));
    const caret = start + (at >= 0 ? at : text.length);
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const save = async (value: string) => {
    setSaving(true);
    try {
      await useEditStore.getState().setText(target.blockId, value, target.side);
      if (value.trim()) {
        // a picture of it, so that exported PDFs can show the new formula as well
        const pt = block.style?.size || block.font_size || 11;
        const box = block.meta?.crop ?? block.bbox;
        const png = await texPng(value, pt / 1.21, box[2] - box[0]);
        if (png) await api.putFormulaImage(target.blockId, value, png).catch(() => undefined);
        else toast('公式已保存。这个浏览器没法生成公式图片，导出的 PDF 里这一处仍是原公式', 'info');
      }
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="formula-editor" role="dialog" aria-label="编辑公式">
      <div className="formula-editor-head">
        <span className="formula-editor-title">编辑公式</span>
        <span className="formula-editor-sub">{target.side === 'src' ? '原文' : '译文'}这一侧，用 LaTeX 书写</span>
        <button type="button" className="icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className={`formula-preview ${preview.error ? 'has-error' : ''}`} aria-live="polite">
        {preview.html ? (
          <span dangerouslySetInnerHTML={{ __html: preview.html }} />
        ) : preview.error ? (
          <span className="formula-error">这里写得不对：{preview.error}</span>
        ) : (
          <span className="formula-empty">预览会出现在这里，例如 f_c = \frac{'{1}{2\\pi RC}'}</span>
        )}
      </div>
      <div className="formula-snippets">
        {SNIPPETS.map((s) => (
          <button key={s.label} type="button" className="formula-snip" title={`${s.hint}  ${s.tex.replace('|', '')}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s.tex)}>
            {s.label}
          </button>
        ))}
      </div>
      <textarea
        ref={area}
        className="formula-input"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        placeholder="在这里写 LaTeX…"
        value={tex}
        onChange={(e) => setTex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && tex.trim() && !preview.error) {
            e.preventDefault();
            void save(tex.trim());
          }
        }}
      />
      <div className="formula-editor-foot">
        {current && (
          <button type="button" className="btn btn-sm" disabled={saving} title="去掉你写的公式，显示文档原来的" onClick={() => void save('')}>
            恢复原公式
          </button>
        )}
        <span className="formula-foot-gap" />
        <button type="button" className="btn btn-sm" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={saving || !tex.trim() || !!preview.error || tex.trim() === current.trim()}
          title="Ctrl+Enter"
          onClick={() => void save(tex.trim())}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
