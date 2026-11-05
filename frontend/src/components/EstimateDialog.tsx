import { useState } from 'react';
import { useViewStore } from '../stores/view';
import type { TranslateEstimate } from '../types';
import { Icon } from './Icon';

const SKIP_KEY = 'pdftr.skipEstimate';

export function skipEstimate(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function money(v: number, cur: string): string {
  return `${cur}${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

function fmtTime(s: number): string {
  if (s < 60) return `约 ${Math.max(5, Math.round(s / 5) * 5)} 秒`;
  const m = Math.round(s / 60);
  return m < 60 ? `约 ${m} 分钟` : `约 ${(m / 60).toFixed(1)} 小时`;
}

/** 翻译全文前的估算：token、费用、时间。 */
export function EstimateDialog({
  est,
  force,
  onConfirm,
  onCancel,
}: {
  est: TranslateEstimate;
  force: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  const openSettings = useViewStore((s) => s.openSettings);
  const confirm = () => {
    if (dontAsk) {
      try {
        localStorage.setItem(SKIP_KEY, '1');
      } catch {
        /* private window */
      }
    }
    onConfirm();
  };
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-sm" role="dialog" aria-label="翻译全文估算" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{force ? '重新翻译全文' : '翻译全文'}</h2>
          <button type="button" className="btn btn-icon" aria-label="关闭" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="est-grid">
            <div>
              <div className="est-big">{est.blocks}</div>
              <div className="est-sub">个文本块要翻译{est.already_done ? `（${est.already_done} 个已完成，跳过）` : ''}</div>
            </div>
            <div>
              <div className="est-big">{fmtTokens(est.total_tokens)}</div>
              <div className="est-sub">
                token（输入 {fmtTokens(est.prompt_tokens)} · 输出 {fmtTokens(est.completion_tokens)}）
              </div>
            </div>
            <div>
              <div className="est-big">{est.cost != null ? money(est.cost, est.currency) : '—'}</div>
              <div className="est-sub">
                {est.cost != null ? (
                  est.cost_peak != null && est.cost_offpeak != null ? (
                    <>
                      现在是{est.peak_now ? '高峰' : '空闲'}时段 · 空闲 {money(est.cost_offpeak, est.currency)} / 高峰{' '}
                      {money(est.cost_peak, est.currency)}
                    </>
                  ) : (
                    `按 ${est.model} 的单价估算`
                  )
                ) : (
                  <>
                    未填写单价，
                    <button type="button" className="link-btn" onClick={() => openSettings('usage')}>
                      去填写
                    </button>
                  </>
                )}
              </div>
            </div>
            <div>
              <div className="est-big">{fmtTime(est.seconds)}</div>
              <div className="est-sub">{est.calls} 次模型调用，3 路并发</div>
            </div>
          </div>
          {est.stale > 0 && (
            <p className="setup-hint">
              其中 {est.stale} 个块已经翻译过，但术语库或模型在那之后改过，会按新的术语重新翻译（手动编辑过的译文不会动）。
            </p>
          )}
          <p className="fieldset-hint">
            <Icon name="coin" size={13} /> 估算按字数计算、输入按缓存未命中计价（实际命中缓存会更便宜），以服务商返回的用量为准，可在 设置 → 用量与费用 查看。
          </p>
          <label className="inline-check">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            以后直接开始，不再显示估算
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={confirm}>
            开始翻译
          </button>
        </div>
      </div>
    </div>
  );
}
