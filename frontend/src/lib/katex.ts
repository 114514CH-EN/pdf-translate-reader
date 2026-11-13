/** KaTeX (≈270 KB + fonts) is only fetched when a formula is actually shown or edited. */
type Katex = typeof import('katex').default;

let lib: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
    lib = m.default;
    return lib;
  });
  return loading;
}

/** the library if it has arrived, without waiting */
export function katexNow(): Katex | null {
  return lib;
}

/** HTML of a formula; throws with KaTeX's message when the LaTeX is wrong (strict = true) */
export function texHtml(k: Katex, tex: string, opts: { display?: boolean; strict?: boolean } = {}): string {
  return k.renderToString(tex, {
    displayMode: opts.display ?? true,
    throwOnError: !!opts.strict,
    strict: 'ignore',
    trust: false,
    output: 'html',
  });
}

// ------------------------------------------------------------------ a picture of a formula (for PDF export)

let fontCss: Promise<string> | null = null;

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** KaTeX's own style rules with every font inlined: an SVG picture cannot fetch anything. */
function inlineKatexCss(): Promise<string> {
  fontCss ??= (async () => {
    const parts: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a stylesheet from elsewhere
      }
      for (const rule of Array.from(rules)) {
        const text = rule.cssText;
        if (rule instanceof CSSFontFaceRule) {
          if (!/KaTeX_/.test(text)) continue;
          const m = /url\("?([^")]+\.woff2)"?\)/.exec(text);
          if (!m) continue;
          const url = new URL(m[1], sheet.href ?? document.baseURI).href;
          const data = toBase64(await (await fetch(url)).arrayBuffer());
          const st = rule.style;
          parts.push(
            `@font-face{font-family:${st.getPropertyValue('font-family')};font-style:${st.getPropertyValue('font-style') || 'normal'};` +
              `font-weight:${st.getPropertyValue('font-weight') || 'normal'};src:url(data:font/woff2;base64,${data}) format("woff2")}`,
          );
        } else if (text.includes('.katex')) {
          parts.push(text);
        }
      }
    }
    return parts.join('\n');
  })();
  return fontCss;
}

/**
 * The formula as a PNG, drawn at 4× (4 px of the picture = 1 px of `fontPx`), on a
 * transparent ground. null when the browser will not let a page draw itself.
 */
export async function texPng(tex: string, fontPx: number, widthPx?: number): Promise<Blob | null> {
  try {
    const k = await loadKatex();
    const css = await inlineKatexCss();
    const holder = document.createElement('div');
    holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    // a numbered formula (\\tag) puts its number at the right edge: it needs the width of the place it goes to
    const wide = widthPx && /\\tag\b/.test(tex) ? `display:inline-block;min-width:${Math.round(widthPx)}px;` : 'display:inline-block;padding:2px 3px;';
    holder.style.cssText = `position:fixed;left:-99999px;top:0;${wide}font-size:${fontPx}px;color:#000;line-height:1.2`;
    holder.innerHTML = `<style>.katex-display{margin:0}.katex-display>.katex>.katex-html:has(>.tag){padding-right:3em}</style>${texHtml(k, tex, { display: true })}`;
    document.body.appendChild(holder);
    await document.fonts.ready;
    const box = holder.getBoundingClientRect();
    const w = Math.ceil(box.width);
    const h = Math.ceil(box.height);
    holder.style.position = 'static';
    holder.style.left = '';
    const style = document.createElement('style');
    style.textContent = css;
    holder.insertBefore(style, holder.firstChild);
    const xhtml = new XMLSerializer().serializeToString(holder);
    holder.remove();
    if (!w || !h) return null;
    const S = 4;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w * S}" height="${h * S}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error('svg'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w * S;
    canvas.height = h * S;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w * S, h * S);
    return await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
  } catch {
    return null;
  }
}
