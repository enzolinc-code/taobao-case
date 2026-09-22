#!/usr/bin/env node
'use strict';

// 配 SKU 颜色图。流程来自真人录屏（_listing-work/recording-9，23 个事件，实测有效）：
//
//   1. 点 SKU 面板的「设置」(.sku-decouple-message > button) → 右侧抽屉打开
//      ← 必须先 scrollIntoView 再取坐标：按钮常在视口外，坐标是负的，点了不报错也不生效
//   2. ★ 在 #struct-p-1627207（颜色分类属性容器）的 header 里勾选那个 pic 复选框
//      ← 这是**启用颜色图模式的开关**，不勾的话颜色项没有 sell-color-option-image-upload，
//        后面所有点击都找不到元素（我卡在这上面很多轮）
//   3. 点第 1 个颜色项的 div.sell-color-option-image-upload（一个入口就够）
//   4. 素材中心里**一次勾选 N 张**（多选，三个颜色一起勾），点「确定」
//   5. 点抽屉底部的「确认创建」
//
// 几个坑：
//   - 抽屉是 div.next-drawer，不是 .next-dialog
//   - **绝对不能按 Escape** —— 会关掉整个抽屉
//   - 素材中心要先切到「全部图片」根目录，否则看不到自己的图
//
// 用法: node fill-sku-color-images.js --dir <产品图片目录> [--dry-run]

const path = require('path');
const {
  connect,
  sleep,
  waitUntil,
  waitForPickerContent,
  switchToAllImages,
  screenshot,
  ensureDir,
  getArg,
  detectRiskSignals,
} = require('./lib/browser');
const { loadAssets } = require('./load-listing-assets');

const SELECTOR_IFRAME = 'sucai-selector-ng';

function pickerOpen(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
        (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
      )
    )
    .catch(() => false);
}

function drawerOpenNow(page) {
  return page
    .evaluate(() => Boolean(document.querySelector('div.next-drawer.next-drawer-right')))
    .catch(() => false);
}

function colorUploadEntryReady(page) {
  return page
    .evaluate(() => Boolean(document.querySelector('#struct-p-1627207 li.has-upload-img div.sell-color-option-image-upload')))
    .catch(() => false);
}

// 关闭 SKU 抽屉。**失败退出前必须调**：抽屉是页面级浮层，
// 留着不关会把后面详情图那步的点击全部挡住（实测报 sku-decouple-drawer-footer intercepts pointer events）。
async function closeDrawer(page) {
  await page.mouse.click(120, 300).catch(() => {});
  await sleep(700);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1200);
  if (await drawerOpenNow(page)) {
    await page.mouse.click(120, 300).catch(() => {});
    await sleep(500);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(1200);
  }
  const still = await drawerOpenNow(page);
  console.log('   收尾：关闭 SKU 抽屉 ' + (still ? '❌ 没关掉' : '✅ 已关闭'));
  return !still;
}

async function cdpClickAt(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 30, y: y - 20, buttons: 0, pointerType: 'mouse' });
  await sleep(100);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await sleep(120);
  }
}

// 读 SKU 表格里各颜色当前的图（前后对比用）
async function readColorImages(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.sell-new-sku-table-content');
    if (!panel) return {};
    const out = {};
    panel.querySelectorAll('tbody tr td').forEach((cell) => {
      const text = (cell.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/【?软壳全包|大孔二合一/.test(text)) return;
      const img = cell.querySelector('img');
      const key = text.slice(0, 16);
      if (!out[key]) out[key] = img ? (img.currentSrc || img.src || '').slice(-36) : null;
    });
    return out;
  });
}

// 素材中心：切「全部图片」→ 按文件名一次勾选多张 → 点确定
async function pickImagesInMaterialCenter(page, baseNames) {
  let frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (!frame) return { ok: false, reason: '素材中心没出现', picked: [], missing: baseNames };

  const sw = await switchToAllImages(page);
  console.log('   切到「全部图片」目录: ' + (sw.ok ? (sw.alreadyThere ? '本来就在（0 秒）' : sw.ms + ' ms') : '失败'));
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;

  const picked = [];
  const missing = [];
  for (const name of baseNames) {
    let index = -1;
    let wrappers = frame.locator('label.next-checkbox-wrapper');
    const total = await wrappers.count();
    for (let i = 0; i < Math.min(total, 40); i++) {
      const text = await wrappers
        .nth(i)
        .evaluate((el) => {
          let node = el;
          let best = '';
          for (let d = 0; d < 5 && node; d++) {
            const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > best.length && t.length < 120) best = t;
            node = node.parentElement;
          }
          return best;
        })
        .catch(() => '');
      if (text && text.includes(name)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      missing.push(name);
      continue;
    }
    const input = wrappers.nth(index).locator('input.next-checkbox-input').first();
    if (await input.count()) {
      await input.evaluate((el) => {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else {
      await wrappers.nth(index).evaluate((el) => el.click());
    }
    picked.push(name);
    await sleep(800);
    frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;
    wrappers = frame.locator('label.next-checkbox-wrapper');
  }

  let confirmed = false;
  for (let attempt = 0; attempt < 10 && !confirmed; attempt++) {
    for (const scope of [page, ...page.frames()]) {
      const byDialog = scope.locator('.batch-fill-sku-image-dialog button').filter({ hasText: /^确定/ }).first();
      const byFooter = scope.locator('button[class*="Footer_selectOk"]').first();
      const btn = (await byDialog.count()) ? byDialog : byFooter;
      if (await btn.count()) {
        const text = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        await btn.click().catch(() => {});
        confirmed = text;
        break;
      }
    }
    if (!confirmed) await sleep(1200);
  }
  // 等弹窗收掉（老写法固定 3.5 秒）
  await waitUntil(async () => !(await pickerOpen(page)), { timeoutMs: 8000, intervalMs: 300, minMs: 400 });
  return { ok: missing.length === 0, picked, missing, confirmed: confirmed || '未找到确认按钮' };
}

async function main() {
  const dir = getArg('dir');
  if (!dir) {
    console.error('用法: node fill-sku-color-images.js --dir <产品图片目录> [--dry-run]');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const assets = loadAssets(dir, {});
  const colors = Object.keys(assets.sku);
  if (!colors.length) {
    console.error('目录里没有 SKU_ 开头的颜色图');
    process.exit(1);
  }
  const baseNames = colors.map((c) => path.basename(assets.sku[c]).replace(/\.[^.]+$/, ''));

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'sku-color-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await sleep(1500);

  const before = await readColorImages(page);
  console.log('替换前颜色图: ' + JSON.stringify(before));
  console.log('要放入 ' + baseNames.length + ' 张: ' + baseNames.join(', '));

  // 第 1 步：确保抽屉开着。
  // 注意：不要先按 Escape —— 抽屉可能已经开着（上一次运行留下的），Escape 会把它关掉。
  const isDrawerOpen = () =>
    page.evaluate(() => Boolean(document.querySelector('div.next-drawer.next-drawer-right')));

  const client = await page.context().newCDPSession(page);
  let drawerOpen = await isDrawerOpen();
  if (drawerOpen) console.log('抽屉已经开着，直接用');

  for (let attempt = 0; attempt < 3 && !drawerOpen; attempt++) {
    const settingsButton = page.locator('.sku-decouple-message button').first();
    if (!(await settingsButton.count())) {
      console.error('SKU 面板里没找到「设置」按钮');
      process.exit(1);
    }
    await settingsButton.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(1200);
    const box = await settingsButton.boundingBox();
    if (box) {
      await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    }
    for (let i = 0; i < 8 && !drawerOpen; i++) {
      await sleep(1000);
      drawerOpen = await isDrawerOpen();
    }
    if (!drawerOpen) console.log('第 ' + (attempt + 1) + ' 次点「设置」没打开抽屉，重试');
  }

  console.log('抽屉打开: ' + drawerOpen);
  if (!drawerOpen) {
    console.log('截图: ' + (await screenshot(page, outDir, 'no-drawer', { always: true })));
    process.exit(1);
  }

  // 第 2 步：★ 勾选「颜色分类」header 里的 pic 复选框，启用颜色图模式
  const toggled = await page.evaluate(() => {
    const container = document.getElementById('struct-p-1627207');
    if (!container) return { ok: false, reason: '没有 #struct-p-1627207' };
    const header = container.querySelector('.header .front-group label.next-checkbox-wrapper.pic');
    if (!header) return { ok: false, reason: '颜色分类 header 里没有 pic 复选框' };
    const input = header.querySelector('input.next-checkbox-input');
    if (input) {
      input.click();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      header.click();
    }
    return { ok: true, wasChecked: header.className.includes('checked') };
  });
  console.log('启用颜色图模式（勾选 header 复选框）: ' + JSON.stringify(toggled));
  // 等颜色项的上传口出现。
  // 原来只等 8 秒，实测偶发超时（平台慢的时候要 8 秒以上），于是这一步失败。
  // 现在等 15 秒；还没出来就**再点一次那个复选框**（开关可能没生效）再等 10 秒。
  let entryWait = await waitUntil(() => colorUploadEntryReady(page), { timeoutMs: 15000, intervalMs: 300, minMs: 400 });
  if (!entryWait.ok) {
    console.log('   等 15 秒还没出现，重新勾一次颜色图模式再等…');
    await page.evaluate(() => {
      const container = document.getElementById('struct-p-1627207');
      const header = container && container.querySelector('.header .front-group label.next-checkbox-wrapper.pic');
      const input = header && header.querySelector('input.next-checkbox-input');
      if (input) {
        input.click();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (header) {
        header.click();
      }
    }).catch(() => {});
    entryWait = await waitUntil(() => colorUploadEntryReady(page), { timeoutMs: 10000, intervalMs: 300, minMs: 400 });
  }
  console.log('   颜色项上传口就绪用了 ' + entryWait.ms + ' ms' + (entryWait.ok ? '' : '（仍超时）'));

  if (dryRun) {
    console.log('（dry-run：只做到启用模式，不选图）');
    console.log('截图: ' + (await screenshot(page, outDir, 'dry-run', { always: true })));
    process.exit(toggled.ok ? 0 : 1);
  }

  // 第 3 步：点第 1 个颜色项的图片上传口
  const uploadEntry = page.locator('#struct-p-1627207 li.has-upload-img div.sell-color-option-image-upload').first();
  if (!(await uploadEntry.count())) {
    console.error('颜色项里没有 sell-color-option-image-upload（启用模式那步可能没生效）');
    console.log('截图: ' + (await screenshot(page, outDir, 'no-upload-entry', { always: true })));
    // 【必须】失败退出前把抽屉关掉：不然这层浮层会挡住后面详情图那步的点击
    //（实测症状：detail 步骤报 "sku-decouple-drawer-footer intercepts pointer events"）。
    await closeDrawer(page);
    process.exit(1);
  }
  await uploadEntry.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(800);
  // 用 CDP 真实鼠标事件点 —— 这个页面对 Playwright 的 click 挑食（事件委托），
  // 直接 click 会出现"点了但什么都没发生，抽屉还被关掉"的情况。
  const entryBox = await uploadEntry.boundingBox();
  if (entryBox) {
    await cdpClickAt(client, Math.round(entryBox.x + entryBox.width / 2), Math.round(entryBox.y + entryBox.height / 2));
  } else {
    await uploadEntry.click().catch(() => {});
  }
  await sleep(500);
  console.log('已点颜色项的图片上传口');

  // 等素材中心真的出现（iframe 一直在，但要看"打开的浮层里有没有它"）
  let pickerReady = false;
  for (let i = 0; i < 10 && !pickerReady; i++) {
    pickerReady = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
          (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
        )
      )
      .catch(() => false);
    if (!pickerReady) await sleep(1000);
  }
  console.log('素材中心打开: ' + pickerReady);
  // 弹窗开着不等于 iframe 内容渲染好了，等一刀再选图
  const skuContentReady = await waitForPickerContent(page, { timeoutMs: 8000 });
  if (!skuContentReady.ok) console.log('   ⚠️ 素材中心内容等超时了，仍继续');

  // 第 4 步：素材中心里一次勾选全部颜色图
  const picked = await pickImagesInMaterialCenter(page, baseNames);
      console.log('选图结果: ' + JSON.stringify(picked));
      if (!picked.picked.length) {
        console.log('截图: ' + (await screenshot(page, outDir, 'pick-failed', { always: true })));
        await closeDrawer(page);
        process.exit(1);
      }

  // 第 5 步：确认创建
  const confirm = page.locator('div.next-drawer.next-drawer-right button').filter({ hasText: /确认创建/ }).first();
  if (await confirm.count()) {
    await confirm.click().catch(() => {});
    console.log('已点「确认创建」');
    // 等抽屉收掉（老写法固定 5 秒）
    await waitUntil(async () => !(await drawerOpenNow(page)), { timeoutMs: 8000, intervalMs: 300, minMs: 500 });
  } else {
    console.log('没找到「确认创建」按钮');
  }

  const after = await readColorImages(page);
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after');
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]).length;
  console.log('');
  console.log('替换后颜色图: ' + JSON.stringify(after));
  console.log('发生变化的数量: ' + changed);
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('=== 未提交商品。 ===');
  process.exit(picked.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  // 任何未预期的异常也要把抽屉关掉，避免连累后续步骤
  (async () => {
    try {
      const { context } = await connect();
      const page = context.pages().find((p) => p.url().includes('publish.htm'));
      if (page && (await drawerOpenNow(page))) await closeDrawer(page);
    } catch (e) {
      // 关不掉就算了，不要因为收尾再抛错
    }
  })().finally(() => process.exit(1));
});
