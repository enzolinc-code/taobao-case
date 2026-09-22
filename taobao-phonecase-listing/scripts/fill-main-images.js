#!/usr/bin/env node
'use strict';

// 一次性把主图填满：点第一个空槽打开素材中心 → 按文件名多选 N 张 → 点「确定（N）」。
//
// 为什么这么做：原来是一张一张挑（每张约 25 秒，10 张要 4 分多钟）。
// 素材中心支持多选，主图和详情图都能一次勾完 —— 5 张主图一次搞定。
//
// 用法: node fill-main-images.js --dir <产品图片目录> --group main|main34|both

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

const CONTAINERS = {
  main: { selector: '#struct-mainImagesGroup', label: '1:1 主图', prefix: '主图' },
  main34: { selector: '#struct-threeToFourImages', label: '3:4 主图', prefix: '主图3比4' },
};

const MAIN_SELECTOR = '#struct-mainImagesGroup';
const MAIN34_SELECTOR = '#struct-threeToFourImages';

const SELECTOR_IFRAME = 'sucai-selector-ng';

// 素材中心弹窗是否已经开着（上一步上传后用 --keep-picker-open 保留时会开着）
function pickerOpen(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
        (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
      )
    )
    .catch(() => false);
}

// 点空槽打开素材中心。关键：iframe 是**常驻挂载**的，弹窗没开时它也在 DOM 里，
// 所以不能"点了就往下走"——必须等主文档里真的出现弹窗，否则会去点隐藏的列表。
// 用 CDP 派发真实鼠标事件点槽位 —— 这个页面对 Playwright 的 click 不认（事件委托）
async function cdpClickAt(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 20, y: y - 15, buttons: 0, pointerType: 'mouse' });
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

async function openPickerFromSlot(page, scope, client) {
  // 用「上传图片」文案定位空槽 —— 这是 upload-listing-images.js 里反复验证过能点开的写法，
  // 而 .main-content.medium.dashed 那个虚线容器点了没反应。
  let emptySlot = scope.locator('text=上传图片').first();
  if (!(await emptySlot.count())) {
    emptySlot = scope.locator('.main-content.medium.dashed').first();
  }
  if (!(await emptySlot.count())) return false;
  await emptySlot.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(800);

  for (let attempt = 0; attempt < 3; attempt++) {
    // 取实时坐标后用 CDP 点：按钮在视口外时坐标是负的，必须每次重新取
    const box = await emptySlot.boundingBox();
    if (box && client) {
      await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    } else {
      await emptySlot.click({ force: true }).catch(() => {});
    }
    for (let i = 0; i < 12; i++) {
      await sleep(800);
      const opened = await page
        .evaluate(() => {
          // 注意：这个选择器弹窗**不是** .next-dialog，而是 .next-overlay-wrapper.opened 里
          // 嵌着素材中心 iframe；而且它的高度可能是 0（实测），所以判断宽度而不是高度。
          return Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
            (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
          );
        })
        .catch(() => false);
      if (opened) return true;
    }
    console.log('    第 ' + (attempt + 1) + ' 次点击没弹出选择图片弹窗，重试');
  }
  return false;
}

async function readSlots(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return { error: 'no ' + sel };
    return {
      slots: node.querySelectorAll('.drag-item').length,
      empty: node.querySelectorAll('.main-content.medium.dashed').length,
      filled: node.querySelectorAll('.drag-item img').length,
    };
  }, selector);
}

// 素材中心里按文件名勾选多张（自定义复选框 → 派发 DOM click）
// 先切到「全部图片」根目录：上传的图都在那里，别停在「复制宝贝」自动建的目录里，
// 否则那一屏根本看不到自己的图（实测卡了很久）。
async function selectManyByName(page, baseNames) {
  let frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (!frame) return { ok: false, reason: '素材中心没出现', picked: [], missing: baseNames };

  const sw = await switchToAllImages(page);
  console.log('    切到「全部图片」目录: ' + (sw.ok ? (sw.alreadyThere ? '本来就在（0 秒）' : sw.ms + ' ms') : '失败'));
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;

  const picked = [];
  const missing = [];

  // 【效率】老写法是"每张图都从头扫一遍列表"，每个候选都要跟浏览器来回一次，
  // 5 张图最多 200 次往返，光这一项就吃掉十几秒。
  // 改成一次把整列名字读回来，在本地比对。每次点击后重读一次，
  // 所以列表即使重排也不会选错。
  const readLabels = () =>
    frame
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

  // 上一步可能是"边传边选"（只等够用的回执就关面板），剩下的文件还在后台上传。
  // 所以先等这几个文件名都出现在列表里再开始勾选，避免误判"找不到"。
  const waitAll = await waitUntil(
    async () => {
      const labels = await readLabels();
      return baseNames.every((n) => labels.some((t) => t && t.includes(n)));
    },
    { timeoutMs: 15000, intervalMs: 600, minMs: 300 }
  );
  console.log('    等全部文件名出现: ' + (waitAll.ok ? waitAll.ms + ' ms' : '超时（缺的会报出来）'));

  for (const name of baseNames) {
    const labels = await readLabels();
    const index = labels.findIndex((t) => t && t.includes(name));
    if (index < 0) {
      missing.push(name);
      continue;
    }
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
    picked.push(name);
    await sleep(500);

    // frame 可能被重建，重新取一次
    frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;
  }

  return { ok: missing.length === 0, picked, missing };
}

// 用页面自带的「从3:4主图裁剪」把 1:1 主图生成出来，省掉 5 张图的上传和勾选。
// 前提：3:4 主图必须先填好。
async function deriveMainFrom34(page, client) {
  const before = await readSlots(page, MAIN_SELECTOR);
  if (!before.error && before.empty === 0) {
    console.log('  1:1 已经有 ' + before.filled + ' 张，跳过裁剪');
    return { ok: true, skipped: true, before, after: before };
  }

  const scope = page.locator(MAIN_SELECTOR).first();
  const btn = scope.locator('button').filter({ hasText: /从3:4主图裁剪/ }).first();
  if (!(await btn.count())) {
    return { ok: false, reason: '没找到「从3:4主图裁剪」按钮', before };
  }
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(700);

  const t0 = Date.now();
  // 这个页面的事件委托挑食，用 CDP 真实鼠标点击更稳
  const box = await btn.boundingBox();
  if (box && client) {
    await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  } else {
    await btn.click().catch(() => {});
  }

  // 可能直接填好，也可能弹一个确认框（有「确定/裁剪」就点掉）
  let after = await readSlots(page, MAIN_SELECTOR);
  for (let i = 0; i < 30 && after.empty !== 0; i++) {
    await sleep(500);
    const dlg = page.locator('.next-dialog button').filter({ hasText: /^(确定|确认|裁剪|应用)$/ }).first();
    if (await dlg.count()) {
      await dlg.click().catch(() => {});
      console.log('   弹窗里点了「' + ((await dlg.innerText().catch(() => '')) || '').trim() + '」');
      await sleep(800);
    }
    after = await readSlots(page, MAIN_SELECTOR);
  }
  const ms = Date.now() - t0;
  console.log('  裁剪生成 1:1: ' + (after.empty === 0 ? '成功' : '失败') + '，用时 ' + ms + ' ms');
  return { ok: after.empty === 0, before, after, ms };
}

async function confirmSelection(page) {
  // 只在"选完槽位还没变"时才会走到这里（见 fillGroup 的说明）。
  // 等待时长保持和老版本一致（10 次 × 1.5 秒），保证兜底行为不比以前差；
  // 省时间靠的是前面那条"实时选中已生效就直接往下走"的快路。
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const scope of [page, ...page.frames()]) {
      const byFooter = scope.locator('button[class*="Footer_selectOk"]').first();
      if (await byFooter.count()) {
        const text = (await byFooter.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        await byFooter.click().catch(() => {});
        await sleep(1500);
        return { confirmed: true, text };
      }
    }
    await sleep(1500);
  }
  return { confirmed: false };
}

async function fillGroup(page, group, files, client) {
  const container = CONTAINERS[group];
  const scope = page.locator(container.selector).first();
  if (!(await scope.count())) return { ok: false, reason: '找不到容器 ' + container.selector };

  const before = await readSlots(page, container.selector);
  if (!before.empty) {
    return { ok: false, reason: container.label + ' 没有空槽（' + before.slots + ' 个都已填），这是替换场景' };
  }

  const baseNames = files.map((f) => path.basename(f).replace(/\.[^.]+$/, ''));
  console.log('  待填 ' + baseNames.length + ' 张: ' + baseNames.join(', '));

  // 素材中心可能已经被上一步（批量上传）留着开在那里 —— 已开就直接用，
  // 省掉"关掉再打开"的一来一回。没开才去点空槽打开。
  if (await pickerOpen(page)) {
    console.log('  素材中心已经开着（上一步留下的），直接用它选图');
  } else if (!(await openPickerFromSlot(page, scope, client))) {
    return { ok: false, reason: '点了空槽但「选择图片」弹窗没出现' };
  }
  // 弹窗出现 ≠ iframe 内容加载完，等「本地上传/全部图片」出现再往下走
  const contentReady = await waitForPickerContent(page, { timeoutMs: 8000 });
  if (!contentReady.ok) console.log('   ⚠️ 素材中心内容等超时了，仍继续');

  const selected = await selectManyByName(page, baseNames);
  console.log('  勾选: ' + JSON.stringify(selected));
  if (!selected.picked.length) return { ok: false, reason: '一张都没勾上', selected };

  // 【效率】主图的选择器是"实时选中"模式：iframe 地址带 realTimeSelect=true，
  // 勾上复选框槽位就立刻变，**没有「确定」按钮**。老写法不管三七二十一去找「确定」，
  // 找不到就空转 10×1.5 秒，两组主图白等 30 秒。
  // 现在改成先看槽位结果，结果没出来再退回去找「确定」。
  let confirmed = { confirmed: false, mode: 'realtime' };
  let after = await readSlots(page, container.selector);
  for (let i = 0; i < 8 && after.empty !== 0; i++) {
    await sleep(500);
    after = await readSlots(page, container.selector);
  }
  if (after.empty !== 0) {
    confirmed = await confirmSelection(page);
    console.log('  实时选中没生效，退回点「确定」: ' + JSON.stringify(confirmed));
    await sleep(1200);
    after = await readSlots(page, container.selector);
  } else {
    console.log('  实时选中已生效，无需点「确定」');
  }

  return { ok: after.empty === 0, before, after, selected, confirmed };
}

async function main() {
  const dir = getArg('dir');
  const group = (getArg('group') || 'both').toLowerCase();
  if (!dir) {
    console.error('用法: node fill-main-images.js --dir <产品图片目录> --group main|main34|both|derive');
    process.exit(1);
  }
  const assets = loadAssets(dir, {});

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'mainfill-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const targets = [];
  if ((group === 'both' || group === 'main') && assets.main.length) targets.push(['main', assets.main]);
  if ((group === 'both' || group === 'main34') && assets.main34.length) targets.push(['main34', assets.main34]);
  const wantDerive = group === 'derive';
  if (!targets.length && !wantDerive) {
    console.error('没有可填的主图');
    process.exit(1);
  }

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  const client = await page.context().newCDPSession(page);

  const results = [];
  for (const [name, files] of targets) {
    console.log('=== ' + CONTAINERS[name].label);
    const result = await fillGroup(page, name, files, client);
    console.log('  → ' + (result.ok ? '成功' : '失败: ' + result.reason) + '  ' + JSON.stringify(result.after || {}));
    results.push({ group: name, ...result });
    if (!result.ok) break;
    await sleep(1500);
  }

  // 用「从3:4主图裁剪」生成 1:1（省掉 5 张图的上传与勾选）
  if (wantDerive || process.argv.includes('--derive-main')) {
    if (results.some((r) => !r.ok)) {
      console.log('=== 跳过「从3:4主图裁剪」（前面有步骤失败）');
    } else {
      console.log('=== 从 3:4 主图裁剪生成 1:1');
      const d = await deriveMainFrom34(page, client);
      console.log('  → ' + (d.ok ? '成功' : '失败: ' + d.reason) + '  ' + JSON.stringify(d.after || {}));
      results.push({ group: 'derive', ...d });
    }
  }

  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after');
  console.log('');
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('=== 未提交商品。 ===');
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});
