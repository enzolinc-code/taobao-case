#!/usr/bin/env node
'use strict';

// 填「白底图」：把 SKU_1 那张图放到 图文描述 → 导购素材 → 白底图 的位置。
//
// 为什么用 SKU_1：白底图要求「尺寸 800x800、纯白背景、商品主体清晰完整」，
// 产品目录里的 SKU_1（全包精孔软壳）是纯白底的产品图，最符合要求。
//
// 结构（2026-09-22 实测）：白底图容器是 #struct-yinHeWhiteBgImage，
// 内部结构和主图组一模一样（image-list > drag-item > 空槽 .main-content.medium.dashed），
// 所以打开素材中心、按文件名勾选、确认这一套可以直接沿用主图那套做法。
//
// 用法: node fill-white-bg-image.js --dir <产品图片目录> [--file SKU_1_xxx.jpg]

const path = require('path');
const {
  connect,
  sleep,
  waitForPickerContent,
  switchToAllImages,
  searchPickerByName,
  searchKeywordFor,
  screenshot,
  ensureDir,
  getArg,
  findPublishPage,
  detectRiskSignals,
} = require('./lib/browser');
const { loadAssets } = require('./load-listing-assets');

const CONTAINER = '#struct-yinHeWhiteBgImage';
const SELECTOR_IFRAME = 'sucai-selector-ng';

async function cdpClickAt(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 20, y: y - 15, buttons: 0, pointerType: 'mouse' });
  await sleep(100);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(120);
  }
}

async function readSlots(page) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return { error: 'no ' + sel };
    return {
      slots: node.querySelectorAll('.drag-item').length,
      empty: node.querySelectorAll('.main-content.medium.dashed').length,
      filled: node.querySelectorAll('.drag-item img').length,
    };
  }, CONTAINER);
}

// 点空槽打开素材中心（这个页面对 Playwright 的 click 不认，要用 CDP 真实鼠标事件）
async function openPickerFromSlot(page, scope, client) {
  let slot = scope.locator('text=上传图片').first();
  if (!(await slot.count())) slot = scope.locator('.main-content.medium.dashed').first();
  if (!(await slot.count())) return false;
  await slot.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(800);

  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await slot.boundingBox();
    if (box && client) {
      await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    } else {
      await slot.click({ force: true }).catch(() => {});
    }
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      const opened = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
            (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
          )
        )
        .catch(() => false);
      if (opened) return true;
    }
    console.log('    第 ' + (attempt + 1) + ' 次点击没弹出素材中心，重试');
  }
  return false;
}

async function selectByName(page, name) {
  let frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (!frame) return { ok: false, reason: '素材中心没出现' };

  const sw = await switchToAllImages(page);
  console.log('    切到「全部图片」目录: ' + (sw.ok ? (sw.alreadyThere ? '本来就在（0 秒）' : sw.ms + ' ms') : '失败'));
  // 列表被别的东西顶满时（例如平台生成的 `商品ID-搜推_NN` 图），按名称先过滤
  const skw = searchKeywordFor([name]);
  const ssr = await searchPickerByName(page, skw);
  console.log('    按名称过滤: ' + (ssr.ok ? skw + '（' + ssr.ms + ' ms）' : '失败 ' + (ssr.reason || '')));
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;

  // 一次把整列名字读回来本地比对（比逐个候选来回问快得多）
  const labels = await frame
    .evaluate(() => {
      const out = [];
      const els = document.querySelectorAll('label.next-checkbox-wrapper');
      for (let i = 0; i < Math.min(els.length, 60); i++) {
        let node = els[i];
        let best = '';
        for (let d = 0; d < 5 && node; d++) {
          const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (t.length > best.length && t.length < 120) best = t;
          node = node.parentElement;
        }
        out.push(best);
      }
      return out;
    })
    .catch(() => []);

  const index = labels.findIndex((t) => t && t.includes(name));
  if (index < 0) return { ok: false, reason: '素材中心里没找到 ' + name, labels: labels.slice(0, 8) };

  const wrappers = frame.locator('label.next-checkbox-wrapper');
  const input = wrappers.nth(index).locator('input.next-checkbox-input').first();
  if (await input.count()) {
    await input.evaluate((el) => {
      el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else {
    await wrappers.nth(index).evaluate((el) => el.click());
  }
  await sleep(600);
  return { ok: true, picked: name };
}

// 老写法这里会去找「确定」并空转；白底图和主图一样是"实时选中"模式，先看结果。
async function settleSelection(page) {
  let after = await readSlots(page);
  for (let i = 0; i < 8 && after.empty !== 0; i++) {
    await sleep(500);
    after = await readSlots(page);
  }
  if (after.empty !== 0) {
    for (const scope of [page, ...page.frames()]) {
      const byFooter = scope.locator('button[class*="Footer_selectOk"]').first();
      if (await byFooter.count()) {
        await byFooter.click().catch(() => {});
        await sleep(1500);
        break;
      }
    }
    after = await readSlots(page);
  }
  return after;
}

async function main() {
  const dir = getArg('dir');
  if (!dir) {
    console.error('用法: node fill-white-bg-image.js --dir <产品图片目录> [--generate]');
    process.exit(1);
  }

  // 【2026-09-22 定稿】默认用目录里的 SKU_1（800x800 正视图、纯白底）作为白底图 —— 结果可控。
  //
  // 为什么不用页面自带的「从主图生成」：实测它**不是随机**（三次结果一致），
  // 但挑中的是第 5 张斜拍主图，而且**点选主图、删除重生成都无法影响它**，
  // 页面也没有"选择源图"的入口 —— 即无法指定用哪张主图。想要正视图只能用 SKU_1。
  // 代价是多花约 4 秒；要改用页面生成，加 --generate。
  const useGenerate = process.argv.includes('--generate');

  // 选图规则：优先用 --file 指定的那张；否则取 SKU_ 里序号为 1 的那张（SKU_1_全包精孔软壳）
  let targetFile = getArg('file');
  if (!useGenerate && !targetFile) {
    const assets = loadAssets(dir, {});
    const entry = Object.entries(assets.sku || {}).find(([k]) => /^1[_\-\s]/.test(k));
    if (!entry) {
      console.error('目录里没有 SKU_1 开头的图，白底图没东西可放');
      process.exit(1);
    }
    targetFile = entry[1];
  }
  const baseName = targetFile ? path.basename(targetFile).replace(/\.[^.]+$/, '') : '';
  console.log(useGenerate ? '白底图：用页面「从主图生成」' : '白底图使用: ' + path.basename(targetFile));

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'whitebg-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = findPublishPage(context);
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1200);

  // 分段计时：先量清楚时间花在哪，再决定优化什么
  const tStart = Date.now();
  const mark = (label) => console.log('   ⏱ ' + label + ': ' + ((Date.now() - tStart) / 1000).toFixed(1) + ' 秒');
  mark('启动');

  const scope = page.locator(CONTAINER).first();
  if (!(await scope.count())) {
    console.error('找不到白底图容器 ' + CONTAINER);
    process.exit(1);
  }

  const before = await readSlots(page);
  console.log('白底图当前: ' + JSON.stringify(before));
  mark('读槽位状态');

  const client = await page.context().newCDPSession(page);
  const t0 = Date.now();

  if (before.empty === 0) {
    console.log('白底图已有内容，跳过');
    console.log('=== 未提交商品。 ===');
    process.exit(0);
  }

  if (useGenerate) {
    // 注：曾试过"生成前先点选第 1 张 1:1 主图"来影响源图，实测**无效**——
    // 点与不点，生成的都是同一张（2026-09-22 验证，见工作记录第二十六节）。
    // 页面没有提供选择源图的入口，要指定白底图只能用 --from-sku。
    // 点「从主图生成」→ 等槽位被填上（可能要弹确认框）
    const btn = scope.locator('button').filter({ hasText: /从主图生成/ }).first();
    if (!(await btn.count())) {
      console.error('没找到「从主图生成」按钮');
      process.exit(1);
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(600);
    const box = await btn.boundingBox();
    if (box) await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    else await btn.click().catch(() => {});
    mark('点「从主图生成」');

    let after = await readSlots(page);
    for (let i = 0; i < 30 && after.empty !== 0; i++) {
      await sleep(500);
      const dlg = page.locator('.next-dialog button').filter({ hasText: /^(确定|确认|生成|应用)$/ }).first();
      if (await dlg.count()) {
        await dlg.click().catch(() => {});
        console.log('   弹窗里点了「确定」');
        await sleep(800);
      }
      after = await readSlots(page);
    }
    const risk2 = await detectRiskSignals(page);
    const shot2 = await screenshot(page, outDir, 'after');
    console.log('白底图现在: ' + JSON.stringify(after) + '（用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）');
    if (risk2.length) console.log('风控信号: ' + risk2.map((r) => r.id).join(', '));
    console.log('截图: ' + shot2);
    console.log('=== 未提交商品。 ===');
    process.exit(after.empty === 0 ? 0 : 1);
  }

  if (!(await openPickerFromSlot(page, scope, client))) {
    console.error('点了白底图空槽但素材中心没出现');
    process.exit(1);
  }
  mark('打开素材中心弹窗');
  const ready = await waitForPickerContent(page, { timeoutMs: 8000 });
  console.log('   素材中心就绪 ' + ready.ms + ' ms');
  mark('等内容就绪');

  const picked = await selectByName(page, baseName);
  console.log('   勾选: ' + JSON.stringify(picked));
  mark('切目录+勾选');
  if (!picked.ok) {
    const shot = await screenshot(page, outDir, 'select-failed', { always: true });
    console.error('截图: ' + shot);
    process.exit(1);
  }

  const after = await settleSelection(page);
  mark('确认生效');
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after');
  console.log('白底图现在: ' + JSON.stringify(after) + '（用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）');
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('=== 未提交商品。 ===');
  process.exit(after.empty === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});
