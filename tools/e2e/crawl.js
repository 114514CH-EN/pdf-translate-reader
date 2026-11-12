// Walks the whole app in a real browser and reports every crash, script error and failed
// request: each document is opened, scrolled end to end in both views and in edit mode
// (both panes), edited, searched; the settings and side panels are opened.
//
//   node tools/e2e/crawl.js http://127.0.0.1:8765 name-of-doc-1 name-of-doc-2 …
//
// Needs `npm i playwright` somewhere on NODE_PATH and a running app with those documents
// (at least one longer than 8 pages — pages that scroll out of range are where v1.8.0 broke).
const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const DOCS = process.argv.slice(3);
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1500, height: 850 } });
  const p = await ctx.newPage(); const errs = [];
  let where = 'start';
  p.on('pageerror', e => errs.push(`[${where}] pageerror: ${e.message.slice(0, 200)}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`[${where}] console: ${m.text().slice(0, 200)}`); });
  p.on('response', r => { if (r.status() >= 400 && !/summary|favicon/.test(r.url())) errs.push(`[${where}] ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
  const crashed = async () => (await p.locator('.crash-screen').count()) > 0 || (await p.locator('.toolbar, .tabbar, [class*="toolbar"]').count()) === 0;
  const scrollAll = async (x) => { await p.mouse.move(x, 500); for (let i = 0; i < 22; i++) { await p.mouse.wheel(0, 900); await p.waitForTimeout(90); } for (let i = 0; i < 22; i++) { await p.mouse.wheel(0, -900); await p.waitForTimeout(60); } await p.waitForTimeout(400); };
  const step = async (name, fn) => { where = name; try { await fn(); } catch (e) { errs.push(`[${name}] step failed: ${e.message.split('\n')[0].slice(0, 160)}`); } if (await crashed()) { errs.push(`[${name}] APP CRASHED / blank`); await p.reload(); await p.waitForTimeout(2500); } };
  for (const path of ['/', '/pet']) {
    await p.goto(BASE + path); await p.waitForTimeout(3000);
    if (path === '/pet') { await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
    for (const doc of DOCS) {
      const T = `${path} ${doc}`;
      await step(`${T} open`, async () => { await p.getByText('文档库').first().click(); await p.waitForTimeout(600); await p.getByText(doc, { exact: true }).first().click(); await p.waitForTimeout(1800); });
      await step(`${T} scroll page-mode`, async () => { await scrollAll(1000); await scrollAll(300); });
      await step(`${T} flow mode`, async () => { await p.getByText('逐句对照').first().click(); await p.waitForTimeout(900); await scrollAll(1000); await p.getByText('整页预览').first().click(); await p.waitForTimeout(700); });
      await step(`${T} edit mode`, async () => {
        await p.getByRole('button', { name: /编辑译文/ }).click(); await p.waitForTimeout(1200); await scrollAll(1000); await scrollAll(300);
        const blk = p.locator('.pane-right .abs-block.editable').first(); if (await blk.count()) { await blk.click(); await p.waitForTimeout(200); await p.getByRole('button', { name: '字号增大' }).click(); await p.getByRole('button', { name: '隐藏' }).click(); await p.waitForTimeout(200); await p.getByRole('button', { name: '撤销' }).click(); await p.getByRole('button', { name: '撤销' }).click(); await p.waitForTimeout(300); }
        const src = p.locator('.pane-left .abs-block').first(); if (await src.count()) { await src.click(); await p.waitForTimeout(300); await p.keyboard.press('Escape'); }
        await p.getByRole('button', { name: '查找替换' }).click(); await p.getByPlaceholder('译文里的文字').fill('的'); await p.getByRole('button', { name: '查找', exact: true }).click(); await p.waitForTimeout(400); await p.keyboard.press('Escape'); await p.locator('.abs-page').first().click({ position: { x: 4, y: 300 } }).catch(() => {});
        await p.getByRole('button', { name: /完成编辑/ }).click(); await p.waitForTimeout(800);
      });
      await step(`${T} zoom`, async () => { await p.keyboard.press('Control+='); await p.waitForTimeout(300); await p.keyboard.press('Control+-'); await p.waitForTimeout(300); });
    }
    await step(`${path} settings tabs`, async () => {
      await p.locator('button[title*="设置"]').last().click(); await p.waitForTimeout(700);
      const tabs = p.locator('.settings-nav-btn'); const n = await tabs.count();
      for (let i = 0; i < n; i++) { await tabs.nth(i).click(); await p.waitForTimeout(350); }
      errs.push(`(info) ${path} settings tabs visited: ${n}`);
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    });
    await step(`${path} side panels`, async () => { for (const t of ['笔记', '术语库', '阅读助手']) { const el = p.getByText(t, { exact: true }).first(); if (await el.count()) { await el.click(); await p.waitForTimeout(300); } } });
    await step(`${path} search`, async () => { await p.keyboard.press('Control+f'); await p.waitForTimeout(300); await p.keyboard.type('filter'); await p.keyboard.press('Enter'); await p.waitForTimeout(600); await p.keyboard.press('Escape'); });
  }
  const real = errs.filter((e) => !e.startsWith('(info)'));
  console.log(errs.join('\n') || 'no errors');
  process.exitCode = real.length ? 1 : 0;
  await b.close();
})();
