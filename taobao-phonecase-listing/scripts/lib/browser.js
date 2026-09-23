'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ENDPOINT = process.env.TAOBAO_CDP_ENDPOINT || 'http://127.0.0.1:9222';

// Playwright 随 Codex 运行时提供。若装在别处，用 TAOBAO_SKILL_NODE_MODULES 指向对应的 node_modules。
const NODE_MODULES_CANDIDATES = [
  process.env.TAOBAO_SKILL_NODE_MODULES,
  process.env.USERPROFILE
    ? path.join(
        process.env.USERPROFILE,
        '.cache',
        'codex-runtimes',
        'codex-primary-runtime',
        'dependencies',
        'node',
        'node_modules'
      )
    : null,
].filter(Boolean);

function loadPlaywright() {
  const tried = [];
  try {
    return require('playwright');
  } catch (err) {
    tried.push('playwright: ' + firstLine(err.message));
  }
  for (const dir of NODE_MODULES_CANDIDATES) {
    try {
      return require(path.join(dir, 'playwright'));
    } catch (err) {
      tried.push(dir + ': ' + firstLine(err.message));
    }
  }
  throw new Error(
    '加载 playwright 失败。已尝试：\n  ' +
      tried.join('\n  ') +
      '\n可用 TAOBAO_SKILL_NODE_MODULES 指向包含 playwright 的 node_modules 目录。'
  );
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等一个条件成立，而不是干等固定的秒数。
// 老代码里大量 sleep(3500)、sleep(4500) 这种写法，页面早就好了还在等，白耗时间。
// probe 里如果抛错就当"条件不成立"继续重试，不会把流程打断。
// 返回 { ok, ms }：ok 表示条件是否在超时前成立，ms 是实际耗时。
async function waitUntil(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 250;
  const minMs = options.minMs ?? 0;
  const started = Date.now();
  if (minMs > 0) await sleep(minMs);
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    let ok = false;
    try {
      ok = await probe();
    } catch (err) {
      lastError = err;
    }
    if (ok) return { ok: true, ms: Date.now() - started };
    await sleep(intervalMs);
  }
  return { ok: false, ms: Date.now() - started, error: lastError ? lastError.message : null };
}

// 素材中心（图片空间）弹窗打开 ≠ 内容加载完。
// 「弹窗出现」后 iframe 里可能还是空白，这时候去找「全部图片」目录会找不到，
// 结果就上传到了默认目录、或者选图时一张都匹配不上。
// 实测踩过：把弹窗等待从固定 4 秒改成"出现就走"之后，日志里少了「已切到全部图片」这一行。
// 所以打开弹窗之后，还要再等 iframe 里真的有内容。
async function waitForPickerContent(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  return waitUntil(
    async () => {
      const frame = page.frames().find((f) => f.url().includes('sucai-selector-ng'));
      if (!frame) return false;
      const txt = await frame
        .evaluate(() => (document.body && document.body.innerText ? document.body.innerText : ''))
        .catch(() => '');
      return /本地上传|全部图片/.test(txt);
    },
    { timeoutMs, intervalMs: 250, minMs: options.minMs ?? 300 }
  );
}

// 「全部图片」这个树节点是不是当前所在的目录？
// 判据：该节点本身或它的祖先带 next-selected 类（实测这个类就挂在
// DIV.next-tree-node-inner 上，只有当前目录才有）。
// 为什么要这个判断：切目录后面原来是一刀切 sleep(3000)，但实测打开素材中心时
// 它往往已经停在「全部图片」（素材中心会记住上次的目录），那 3 秒纯属白等。
async function isAllImagesFolder(page, frameUrlPart = 'sucai-selector-ng') {
  const frame = page.frames().find((f) => f.url().includes(frameUrlPart));
  if (!frame) return false;
  return frame
    .evaluate(() => {
      const nodes = [...document.querySelectorAll('*')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t === '全部图片' && el.children.length === 0;
      });
      for (const n of nodes) {
        let p = n;
        for (let i = 0; i < 6 && p; i++) {
          if (typeof p.className === 'string' && p.className.includes('next-selected')) return true;
          p = p.parentElement;
        }
      }
      return false;
    })
    .catch(() => false);
}

// 切到「全部图片」目录。已在的话直接返回（0 秒）；否则点一下并**等它真的变成选中态**，
// 而不是盲等固定秒数。
async function switchToAllImages(page, options = {}) {
  const frameUrlPart = options.frameUrlPart || 'sucai-selector-ng';
  if (await isAllImagesFolder(page, frameUrlPart)) {
    return { ok: true, alreadyThere: true, ms: 0 };
  }
  const frame = page.frames().find((f) => f.url().includes(frameUrlPart));
  if (!frame) return { ok: false, reason: '素材中心没出现', ms: 0 };
  const item = frame.locator('text=全部图片').first();
  if (!(await item.count())) return { ok: false, reason: '没找到「全部图片」', ms: 0 };

  const t0 = Date.now();
  await item.click().catch(() => {});
  const r = await waitUntil(() => isAllImagesFolder(page, frameUrlPart), {
    timeoutMs: options.timeoutMs ?? 6000,
    intervalMs: 200,
    minMs: 300,
  });
  return { ok: r.ok, switched: true, ms: Date.now() - t0 };
}

// 两次操作之间的随机停顿。固定节奏本身就是风控特征。
async function pace(minMs, maxMs) {
  const min = minMs ?? Number(process.env.TAOBAO_PACE_MIN_MS || 400);
  const max = maxMs ?? Number(process.env.TAOBAO_PACE_MAX_MS || 1400);
  const span = Math.max(1, max - min);
  await sleep(min + Math.floor(Math.random() * span));
}

// 只挂接已在运行的 Chrome，绝不启动新实例。
// 注意：不要调用 browser.close()，那会关掉用户正在用的浏览器并丢失登录态。
async function connect(endpoint = DEFAULT_ENDPOINT) {
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    throw new Error(
      '无法连接 CDP（' +
        endpoint +
        '）。Chrome 必须带 --remote-debugging-port 运行。\n原因：' +
        firstLine(err.message)
    );
  }
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('CDP 已连接，但没有可用的浏览器上下文。');
  }
  return { browser, context };
}

function publishUrl(catId) {
  return (
    'https://item.upload.taobao.com/sell/v2/publish.htm?catId=' +
    encodeURIComponent(catId) +
    '&fromAICategory=true'
  );
}

const LOGIN_HINTS = ['login.taobao.com', 'login.tmall.com', 'havanaone', 'loginmyseller'];

function isLoginUrl(url) {
  return LOGIN_HINTS.some((hint) => String(url || '').includes(hint));
}

// 【2026-09-23 起】挑发布页：优先环境变量指定的那一张，否则用**最近打开的那一张**。
//
// 为什么不用原来的"第一张"：流水线是「先开一张复制页，再在上面上传/填图」。
// 如果上一轮失败后草稿页没关，桌面上就会有两张发布页，而"第一张"是**上一轮的旧草稿** ——
// 上传、填图、提交全都会落到那张旧页面上，新页反而空着。
// 2026-09-23 新加的"上传失败就中止"会留下这种旧页，所以必须改成认最新的那张。
// 环境变量 TAOBAO_TARGET_PAGE_HINT（或调用方传 hint）用来在有多张时精确指定，
// 例如流水线里用 'copyItem=true&itemId=1083698755183'。
function findPublishPage(context, hint) {
  const pages = context.pages().filter((p) => String(p.url()).includes('publish.htm'));
  if (!pages.length) return undefined;
  const want = hint || process.env.TAOBAO_TARGET_PAGE_HINT || '';
  if (want) {
    const hit = pages.filter((p) => String(p.url()).includes(want));
    if (hit.length) return hit[hit.length - 1];
  }
  return pages[pages.length - 1];
}

async function openPublishPage(context, url) {
  const existing = context.pages().find((p) => p.url().includes('publish.htm'));
  if (existing) {
    await existing.bringToFront().catch(() => {});
    return existing;
  }
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

// 控件常在 iframe 中（图片空间尤其如此）。用 frame 的 URL 片段定位，避免坐标偏移。
async function resolveFrame(page, frameUrlPart, timeoutMs = 10000) {
  if (!frameUrlPart) return page;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((f) => f !== page.mainFrame() && f.url().includes(frameUrlPart));
    if (frame) return frame;
    await sleep(500);
  }
  throw new Error('找不到 URL 包含 "' + frameUrlPart + '" 的 iframe');
}

async function locatorOf(ctx, selector, index = 0) {
  const el = ctx.locator(selector).nth(index);
  await el.waitFor({ state: 'visible', timeout: 15000 });
  return el;
}

// 真实键盘输入：直接改 DOM 的 value 会被前端框架在提交时忽略。
async function realType(ctx, selector, value, index = 0) {
  const el = await locatorOf(ctx, selector, index);
  await el.click();
  await el.press('Control+A').catch(() => {});
  await el.press('Backspace').catch(() => {});
  const typed = typeof el.pressSequentially === 'function'
    ? el.pressSequentially(String(value), { delay: 30 })
    : el.type(String(value), { delay: 30 });
  await typed;
  await el.press('Tab').catch(() => {});
}

// 组件库托管的输入框：用原生 setter 赋值再派发 input/change。
async function nativeSetValue(ctx, selector, value, index = 0) {
  const el = await locatorOf(ctx, selector, index);
  await el.evaluate((node, v) => {
    const proto = node instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(node, v);
    else node.value = v;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new Event('blur', { bubbles: true }));
  }, String(value));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 属性下拉是淘宝自定义组件：点开 → 列表虚拟滚动，选项多时必须先用搜索框筛选 → 再点选项。
// 直接按文本找会因为目标项没被渲染而失败，所以这里带搜索和重试。
const OPTION_SELECTOR =
  '.options-item, .next-menu-item:not(.next-nav-item), li[role="option"], [role="option"]';

async function chooseOption(ctx, selector, value, index = 0) {
  // 前一个下拉没完全关闭时会盖住下一个控件，导致点击超时。开新的之前先清一次。
  if (ctx.keyboard && typeof ctx.keyboard.press === 'function') {
    await ctx.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }

  const el = await locatorOf(ctx, selector, index);
  const tag = await el.evaluate((node) => node.tagName.toLowerCase());
  if (tag === 'select') {
    await el.selectOption({ label: String(value) });
    return;
  }

  const want = String(value);
  const exact = new RegExp('^\\s*' + escapeRegExp(want) + '\\s*$');

  for (let attempt = 1; attempt <= 3; attempt++) {
    await el.click();
    await ctx
      .waitForSelector(OPTION_SELECTOR, { timeout: 6000, state: 'visible' })
      .catch(() => {});
    await sleep(500);

    // 虚拟列表只渲染前十几项，先用搜索框把目标筛出来。
    const search = ctx.locator('.options-search input').first();
    if (await search.count()) {
      await search.fill(want).catch(() => {});
      await sleep(700);
    }

    const option = ctx.locator(OPTION_SELECTOR).filter({ hasText: exact }).first();
    if (await option.count()) {
      return await clickOption(option);
    }

    // 精确匹配失败时退到前缀匹配：少写一个字（如"高腰"对"高腰型"）不该让整行失败。
    // 只有唯一候选才采用，多个候选说明有歧义，交回人工。
    const prefix = ctx
      .locator(OPTION_SELECTOR)
      .filter({ hasText: new RegExp('^\\s*' + escapeRegExp(want)) });
    const prefixCount = await prefix.count();
    if (prefixCount === 1) {
      return await clickOption(prefix.first());
    }
    if (prefixCount > 1) {
      const candidates = (await prefix.allInnerTexts()).map((t) => t.trim());
      throw new Error('选项有歧义，多个候选: ' + candidates.join(' / '));
    }
    await sleep(500);
  }

  throw new Error('下拉中找不到选项: ' + want + '（已重试 3 次）');
}

// 返回实际选中的文案，供调用方记录"用户写的值"与"实际落下的值"是否一致。
async function clickOption(option) {
  const matched = (await option.innerText()).trim();
  await option.scrollIntoViewIfNeeded().catch(() => {});
  await option.click();
  await sleep(400);
  return matched;
}

async function uploadFiles(ctx, selector, files, index = 0) {
  const el = ctx.locator(selector).nth(index);
  await el.waitFor({ state: 'attached', timeout: 15000 });
  await el.setInputFiles(files);
}

// 淘宝的上传控件是点击时才创建 input[type=file]，DOM 里查不到。
// 用文件选择器拦截：点上传按钮，捕获随之弹出的文件选择事件，再塞入文件。
// 注意：只能对 Page 使用，iframe 里的控件不支持这个策略。
async function uploadViaChooser(ctx, selector, files, index = 0) {
  if (typeof ctx.waitForEvent !== 'function') {
    throw new Error('filechooser 策略只能用于主页面，不能用于 iframe 内的控件');
  }
  const el = await locatorOf(ctx, selector, index);
  const [chooser] = await Promise.all([
    ctx.waitForEvent('filechooser', { timeout: 15000 }),
    el.click(),
  ]);
  await chooser.setFiles(files);
}

// 截图开关：发布页整页约 5000 像素高，一张 PNG 0.7–1 MB，fullPage 截图本身也要一两秒。
// 每步都截的话，一条链接要多花十几秒、多写约 5 MB —— 这是纯粹的算力/磁盘开销。
// 策略：**成功路径默认不截**，只有两种情况才截：
//   1. 出错诊断（调用时传 { always: true }）；
//   2. 显式要求留证（设 TAOBAO_SHOTS=1 或加 --shots 参数）。
function shotsEnabled() {
  return process.env.TAOBAO_SHOTS === '1' || process.argv.includes('--shots');
}

async function screenshot(page, dir, name, opts = {}) {
  if (!opts.always && !shotsEnabled()) return '';
  ensureDir(dir);
  const file = path.join(dir, name + '.png');
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    await page.screenshot({ path: file }).catch(() => {});
  }
  return file;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getArg(name, fallback) {
  const prefix = '--' + name + '=';
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf('--' + name);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function getPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// 风控信号：命中任意一条就停止当天批次，交真人处理，不要重试硬闯。
const RISK_PATTERNS = [
  { id: 'captcha', re: /拖动滑块|滑块验证|请完成验证|点击完成验证|安全验证|验证码/ },
  { id: 'sms', re: /短信验证|短信校验|发送验证码/ },
  { id: 'face', re: /人脸|实人认证|扫脸/ },
  { id: 'rate-limit', re: /操作过于频繁|操作频繁|频率过高|请稍后再试|访问受限|系统繁忙/ },
  { id: 'login', re: /登录已过期|请重新登录|请先登录/ },
];

async function detectRiskSignals(page) {
  const text = await page
    .evaluate(() => (document.body ? document.body.innerText : ''))
    .catch(() => '');
  const hits = [];
  for (const { id, re } of RISK_PATTERNS) {
    const matched = String(text).match(re);
    if (matched) hits.push({ id, matched: matched[0] });
  }
  return hits;
}

// 发布页用"错误(N)"汇总缺字段与格式问题。填完不等于填对，这个必须读回来。
async function readErrorMarkers(page) {
  return page
    .evaluate(() => {
      const hits = Array.from(document.querySelectorAll('body *'))
        .filter((el) => /错误\s*[(（]\s*\d+\s*[)）]/.test(el.textContent || ''))
        .slice(0, 10)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200));
      return Array.from(new Set(hits));
    })
    .catch(() => []);
}

module.exports = {
  DEFAULT_ENDPOINT,
  loadPlaywright,
  sleep,
  waitUntil,
  waitForPickerContent,
  shotsEnabled,
  isAllImagesFolder,
  switchToAllImages,
  pace,
  connect,
  publishUrl,
  isLoginUrl,
  findPublishPage,
  openPublishPage,
  resolveFrame,
  realType,
  nativeSetValue,
  chooseOption,
  uploadFiles,
  uploadViaChooser,
  screenshot,
  ensureDir,
  writeJson,
  readJson,
  getArg,
  getPath,
  detectRiskSignals,
  readErrorMarkers,
};
