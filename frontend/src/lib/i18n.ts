import { EN } from './i18n-en';

/**
 * English interface.
 *
 * The components are written in Chinese. Rather than thread a translate call through
 * every one of them, the finished page is translated: text and the title / placeholder /
 * aria-label attributes of the interface are looked up in a dictionary (lib/i18n-en.ts)
 * or matched by a few patterns ("第 3 页，共 12 页"). What you read — pages, translations,
 * notes, document names — is never touched. Strings the dictionary does not know stay
 * Chinese; that is the honest fallback.
 *
 * React keeps writing Chinese into its own text nodes; every such write is seen by a
 * MutationObserver and translated again before the browser paints.
 */

const KEY = 'pdftr.lang';
export type Lang = 'zh' | 'en';

export function getLang(): Lang {
  try {
    return window.localStorage.getItem(KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/** Switching reloads the page: every string is then written once, in the right language. */
export function setLang(lang: Lang): void {
  try {
    window.localStorage.setItem(KEY, lang);
  } catch {
    /* private window: lasts until reload */
  }
  window.location.reload();
}

const CJK = /[\u4e00-\u9fff]/;
const VIEW: Record<string, string> = { 整页预览: 'Page view', 逐句对照: 'Sentence view' };
const SIDE: Record<string, string> = { 原文: 'Original', 译文: 'Translation' };

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^第 (\d+) 页，共 (\d+) 页$/, (m) => `Page ${m[1]} of ${m[2]}`],
  [/^读到第 (\d+) 页，共 (\d+) 页$/, (m) => `Page ${m[1]} of ${m[2]}`],
  [/^读到第 (\d+) 页$/, (m) => `Stopped at page ${m[1]}`],
  [/^第 (\d+) 页$/, (m) => `Page ${m[1]}`],
  [/^共 (\d+) 页$/, (m) => `${m[1]} pages`],
  [/^(\d+) 页$/, (m) => `${m[1]} ${m[1] === '1' ? 'page' : 'pages'}`],
  [/^(\d+) 页(，已打开)?$/, (m) => `${m[1]} pages${m[2] ? ', open' : ''}`],
  [/^已译 (\d+)%$/, (m) => `${m[1]}% translated`],
  [/^(\d+) 份$/, (m) => m[1]],
  [/^(\d+) \/ (\d+) 份$/, (m) => `${m[1]} of ${m[2]}`],
  [/^(\d+) 个术语，已采用 (\d+)$/, (m) => `${m[1]} terms, ${m[2]} approved`],
  [/^(\d+) \/ (\d+) 个术语，已采用 (\d+)$/, (m) => `${m[1]} of ${m[2]} terms, ${m[3]} approved`],
  [/^(整页预览|逐句对照)，第 (\d+) 页$/, (m) => `${VIEW[m[1]]}, page ${m[2]}`],
  [/^(原文|译文)第 (\d+) 页$/, (m) => `${SIDE[m[1]]}, page ${m[2]}`],
  [/^(原文|译文)这一侧，用 LaTeX 书写$/, (m) => `${SIDE[m[1]]} side, written in LaTeX`],
  [/^已添加第 (\d+) 页$/, (m) => `Page ${m[1]} added`],
  [/^把第 (\d+) 页往前移$/, (m) => `Move page ${m[1]} earlier`],
  [/^把第 (\d+) 页往后移$/, (m) => `Move page ${m[1]} later`],
  [/^删除第 (\d+) 页…$/, (m) => `Delete page ${m[1]}…`],
  [/^确认删除第 (\d+) 页（不能撤销）$/, (m) => `Really delete page ${m[1]} (cannot be undone)`],
  [/^这一页现在是第 (\d+) 页$/, (m) => `This page is now page ${m[1]}`],
  [/^(\d+) 天前打开过$/, (m) => `Opened ${m[1]} days ago`],
  [/^关联第 (\d+) 页$/, (m) => `Link to page ${m[1]}`],
  [/^全部 (\d+)$/, (m) => `All ${m[1]}`],
  [/^高亮 (\d+)$/, (m) => `Highlights ${m[1]}`],
  [/^笔记 (\d+)$/, (m) => `Notes ${m[1]}`],
  [/^今天 (\d\d:\d\d)$/, (m) => `Today ${m[1]}`],
  [/^没有名称里带「(.*)」的文档$/, (m) => `No document with “${m[1]}” in its name`],
  [/^没有匹配「(.*)」的术语$/, (m) => `No term matches “${m[1]}”`],
  [/^翻译进度 (\d+)%$/, (m) => `Translation progress ${m[1]}%`],
  [/^已翻译 (\d+)\/(\d+) 个文本块(?:，(\d+) 个失败)?$/, (m) => `${m[1]} of ${m[2]} text blocks translated${m[3] ? `, ${m[3]} failed` : ''}`],
  [/^第 (\d+) 页：已译 (\d+)\/(\d+)$/, (m) => `Page ${m[1]}: ${m[2]} of ${m[3]} translated`],
  [/^约 (\d+) 秒$/, (m) => `about ${m[1]} s`],
  [/^已译 (\d+)% · (\d+) 失败$/, (m) => `${m[1]}% translated, ${m[2]} failed`],
  [/^第 (\d+) 页：已译 (\d+)\/(\d+)，(\d+) 个失败$/, (m) => `Page ${m[1]}: ${m[2]} of ${m[3]} translated, ${m[4]} failed`],
  [/^已加密保存（(.*)）$/, (m) => `Stored encrypted (${m[1]})`],
  [/^(.+) 输入单价（缓存未命中）$/, (m) => `${m[1]} input price (not cached)`],
  [/^(.+) 输入单价（缓存命中）$/, (m) => `${m[1]} input price (cached)`],
  [/^(.+) 输出单价$/, (m) => `${m[1]} output price`],
  [/^(.+) 高峰倍率$/, (m) => `${m[1]} peak multiplier`],
  [/^次模型调用，(\d+) 路并发$/, (m) => ` model calls, ${m[1]} at a time`],
  [/^第 (\d+) 页往前一位$/, (m) => `Page ${m[1]} one place earlier`],
  [/^第 (\d+) 页往后一位$/, (m) => `Page ${m[1]} one place later`],
  [/^线条颜色：(.+)$/, (m) => `Line colour: ${EN[m[1]] ?? m[1]}`],
  [/^适合宽度（(.+?)）（开启后随窗口和面板宽度自动调整）$/, (m) => `Fit width (${m[1]}); follows the window and panel width`],
  [/^打开 (.+)$/, (m) => `Open ${m[1]}`],
  [/^关闭 (.+)$/, (m) => `Close ${m[1]}`],
  [/^删除 (.+)$/, (m) => `Delete ${m[1]}`],
];

/** null: not something we know how to say in English */
export function en(text: string): string | null {
  const core = text.trim();
  if (!core || !CJK.test(core)) return null;
  let out = EN[core];
  if (out === undefined) {
    for (const [re, fn] of RULES) {
      const m = re.exec(core);
      if (m) {
        out = fn(m);
        break;
      }
    }
  }
  if (out === undefined) {
    // "设置（Ctrl+,）" — a known label with a shortcut or a remark in brackets
    const m = /^(.+?)（([^（）]*)）$/.exec(core);
    if (m && EN[m[1]] !== undefined) out = `${EN[m[1]]} (${EN[m[2]] ?? m[2]})`;
    // "译文这一侧：…" style prefixes are left alone
  }
  if (out === undefined) return null;
  return text.replace(core, out);
}

/** What is being read, typed or named by the reader: never translated. */
const KEEP =
  '.abs-page, .pdf-page, .flow-view, .note-content, .hl-quote, .md, .chat-msg, .chat-list, textarea, input, [contenteditable="true"], .lang-switch, ' +
  '.term-input, .home-card-title, .home-now-title, .home-peek-title, .doc-tab-title, .lib-title, .katex, .formula-preview, code, pre, script, style, .pet-bubble';
const ATTRS = ['title', 'placeholder', 'aria-label'];

export function startEnglish(): void {
  if (getLang() !== 'en') return;
  document.documentElement.lang = 'en';
  const zhOf = new WeakMap<Text, string>(); // what React last wrote into a text node
  let applying = false;

  const kept = (el: Element | null) => !el || !!el.closest(KEEP);

  const textOf = (el: Element) => {
    // an element made only of text pieces ("第 ", "3", " 页") is one sentence
    // (also between elements: a checkbox, then "关联第 ", "1", " 页")
    const runs: Text[][] = [[]];
    for (const k of Array.from(el.childNodes)) {
      if (k.nodeType === Node.TEXT_NODE) runs[runs.length - 1].push(k as Text);
      else runs.push([]);
    }
    for (const run of runs) {
      if (run.length > 1) {
        const out = en(run.map((k) => zhOf.get(k) ?? k.data).join(''));
        if (out !== null) {
          if (run[0].data !== out) run[0].data = out;
          for (const k of run.slice(1)) if (k.data !== '') k.data = '';
          continue;
        }
      }
      for (const k of run) {
        const out = en(zhOf.get(k) ?? k.data);
        if (out !== null && k.data !== out) k.data = out;
      }
    }
  };

  const attrsOf = (el: Element) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) {
        const out = en(v);
        if (out !== null) el.setAttribute(a, out);
      }
    }
  };

  const walk = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) {
      const p = root.parentElement;
      if (p && !kept(p)) textOf(p);
      return;
    }
    if (!(root instanceof Element)) return;
    // attributes belong to the interface even on elements whose text is the reader's (an input's placeholder)
    attrsOf(root);
    for (const el of Array.from(root.querySelectorAll('[title], [placeholder], [aria-label]'))) attrsOf(el);
    if (kept(root)) return;
    const seen = new Set<Element>();
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      const t = n as Text;
      const p = t.parentElement;
      if (!p || seen.has(p)) continue;
      if (!CJK.test(t.data) && !zhOf.has(t)) continue;
      seen.add(p);
      if (!kept(p)) textOf(p);
    }
  };

  const run = (fn: () => void) => {
    applying = true;
    try {
      fn();
    } finally {
      observer.takeRecords(); // our own writes are not news
      applying = false;
    }
  };

  const observer = new MutationObserver((records) => {
    if (applying) return;
    run(() => {
      for (const r of records) {
        if (r.type === 'characterData') {
          const t = r.target as Text;
          zhOf.set(t, t.data); // React wrote this
          const p = t.parentElement;
          if (p && !kept(p)) textOf(p);
        } else if (r.type === 'attributes') {
          attrsOf(r.target as Element);
        } else {
          r.addedNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) zhOf.set(n as Text, (n as Text).data);
            walk(n);
          });
        }
      }
    });
  });
  const begin = () => {
    run(() => walk(document.body));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const title = document.querySelector('title');
    const fixTitle = () => {
      const m = /^(.*) - (PDF 双语翻译阅读器.*)$/.exec(document.title);
      const out = m ? `${m[1]} - ${EN[m[2]] ?? m[2]}` : EN[document.title];
      if (out && out !== document.title) document.title = out;
    };
    fixTitle();
    if (title) new MutationObserver(fixTitle).observe(title, { childList: true, characterData: true, subtree: true });
  };
  if (document.body) begin();
  else document.addEventListener('DOMContentLoaded', begin);
}
