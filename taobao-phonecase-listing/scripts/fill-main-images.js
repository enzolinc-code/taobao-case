#!/usr/bin/env node
'use strict';

// 一次性把主图填满：点第一个空槽打开素材中心 → 按文件名多选 N 张 → 点「确定（N）」。
//
// 为什么这么做：原来是一张一张挑（每张约 25 秒，10 张要 4 分多钟）。
// 素材中心支持多选，主图和详情图都能一次勾完 —— 5 张主图一次搞定。
//
// 用法: node fill-main-images.js --dir <产品图片目录> --group main|main34|both

const path = require('path');
const fs = require('fs');
const {
  connect,
  sleep,
  waitUntil,
  waitForPickerContent,
  switchToAllImages,
  screenshot,
  ensureDir,
  getArg,
  findPublishPage,
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

// 关掉素材中心弹窗（先点页面空白把焦点移出 iframe，再 Escape）
async function closePicker(page) {
  await page.mouse.click(120, 300).catch(() => {});
  await sleep(700);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1200);
  return !(await pickerOpen(page));
}

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

// ── 逐张核对：选中的图必须就是"本次刚上传"的那几张 ──────────────────
// 背景：素材库里同名文件极多（每个设计都叫 主图3比4_05.jpg），按名字选图时
// 只有"新文件排在最前"才选得对。2026-09-22 因为提前选图，命中别人的旧文件，
// 导致 062–064 三条链接第 5 张主图错。这道核对就是为了拦住这类错误。
function loadUploadedMap() {
  const candidates = [
    path.resolve('_listing-work', 'last-upload.json'),
    path.resolve(__dirname, '..', '..', '_listing-work', 'last-upload.json'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const map = new Map();
      for (const it of j.files || []) map.set(String(it.file).replace(/\.[^.]+$/, ''), it.oid);
      if (map.size) return { map, file: f, at: j.at };
    } catch (e) {
      // 读不动就当下没有
    }
  }
  return null;
}

async function readSlotOids(page, selector) {
  return page
    .evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return [];
      return [...node.querySelectorAll('.drag-item img')].map((img) => {
        const m = (img.currentSrc || img.src || '').match(/(O1CN[A-Za-z0-9]+)/);
        return m ? m[1] : null;
      });
    }, selector)
    .catch(() => []);
}

async function verifySlotsAreOurs(page, selector, expectedNames) {
  const up = loadUploadedMap();
  // ⚠️ 清单缺失/为空时必须**判定失败**，不能"跳过"。
  // 2026-09-23 教训：105 那条上传回执异常（29/21）导致清单写成 0 个文件，
  // 当时这里打印"跳过核对"就放行了 —— 又一次变成"看起来成功"。
  // 核对是本流程唯一能发现"选到别人的同名旧文件"的手段，绝不能静默降级。
  if (!up || up.map.size === 0) {
    return {
      checked: true,
      problems: ['没有可用的本次上传清单（last-upload.json 缺失或为空）——无法确认选中的是不是本次上传的图，按失败处理'],
    };
  }
  const oids = await readSlotOids(page, selector);
  const problems = [];
  expectedNames.forEach((name, i) => {
    const want = up.map.get(name);
    const got = oids[i] || null;
    if (!want) {
      problems.push(name + ' 不在本次上传清单里');
      return;
    }
    if (got !== want) {
      problems.push(name + ' 槽位是 ' + (got || '空') + '，应为本次上传的 ' + want);
    }
  });
  return { checked: true, problems, oids };
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

  // ── 选图方式：**按图片编号（O1CN…）选，不按文件名 ──────────────────
  // 素材库里每个设计都有同名的 主图_1.jpg / 主图3比4_05.jpg，
  // 按名字选是"取第一个匹配"，列表顺序不可控 —— 2026-09-22/23 两次事故都是这么来的。
  // 上传回执里有"文件名 → 图片编号"，素材中心每张缩略图的地址里也带编号，
  // 所以改为：拿编号去找对应的那张卡片，**同名文件再多也不会选错**。
  const up = loadUploadedMap();
  if (!up || up.map.size === 0) {
    return {
      ok: false,
      reason: '没有可用的本次上传清单，无法按编号选图（拒绝按名字猜）',
      picked: [],
      missing: baseNames,
    };
  }

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

  // 按编号找卡片：返回该编号对应卡片的复选框序号
  const findIndexByOid = (oid) =>
    frame
      .evaluate((target) => {
        const imgs = [...document.querySelectorAll('img')];
        const all = [...document.querySelectorAll('label.next-checkbox-wrapper')];
        for (const img of imgs) {
          if (!(img.src || '').includes(target)) continue;
          let n = img;
          for (let d = 0; d < 6 && n; d++) {
            n = n.parentElement;
            if (!n) break;
            const cb = n.querySelector('label.next-checkbox-wrapper');
            if (cb) {
              const i = all.indexOf(cb);
              if (i >= 0) return i;
            }
          }
        }
        return -1;
      }, oid)
      .catch(() => -1);

  // 等这几张"按编号"在列表里出现（上传可能还在后台跑）
  const waitAll = await waitUntil(
    async () => {
      for (const n of baseNames) {
        const want = up.map.get(n);
        if (!want) return false;
        if ((await findIndexByOid(want)) < 0) return false;
      }
      return true;
    },
    { timeoutMs: 20000, intervalMs: 600, minMs: 300 }
  );
  console.log('    等本次上传的图按编号出现: ' + (waitAll.ok ? waitAll.ms + ' ms' : '超时（缺的会报出来）'));

  for (const name of baseNames) {
    const want = up.map.get(name);
    if (!want) {
      missing.push(name + '(清单里没有)');
      continue;
    }
    const index = await findIndexByOid(want);
    if (index < 0) {
      missing.push(name + '(编号 ' + want + ' 没在列表里找到)');
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

// allowReuse：是否允许复用"上一步留下的、已经打开的"素材中心弹窗。
// ⚠️ 弹窗是有归属的：从哪个槽位打开，选中的图就进哪一组。
// 上传步骤是从 3:4 区域打开的，所以**只有 3:4 组能复用**；
// 1:1 组如果直接复用，勾选会落到 3:4 上、1:1 全空（2026-09-23 实测踩过）。
async function fillGroup(page, group, files, client, allowReuse = false) {
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
  if (allowReuse && (await pickerOpen(page))) {
    console.log('  素材中心已经开着（上一步留下的），直接用它选图');
  } else {
    // 有残留弹窗（但归属不对）就先关掉，再从本组空槽重新打开
    if (await pickerOpen(page)) {
      const closed = await closePicker(page);
      console.log('  先关掉上一步留下的弹窗（归属不对），再从本组槽位打开: ' + (closed ? '已关闭' : '⚠️ 没关掉'));
    }
    if (!(await openPickerFromSlot(page, scope, client))) {
      return { ok: false, reason: '点了空槽但「选择图片」弹窗没出现' };
    }
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

  // 【硬校验】槽位里的图必须就是本次上传的那几张（按文件名一一对应）。
  // 只有 1:1 是"由 3:4 裁剪生成"的时候跳过（那些图不是我们上传的，是页面生成的）。
  let verify = { checked: false };
  if (group === 'main34' || group === 'main') {
    verify = await verifySlotsAreOurs(page, container.selector, baseNames);
    if (!verify.checked) {
      console.log('   ⚠️ 图源核对: ' + verify.reason);
    } else if (verify.problems.length) {
      console.log('   ❌ 图源核对不通过:');
      verify.problems.forEach((p) => console.log('      - ' + p));
    } else {
      console.log('   ✅ 图源核对通过：' + baseNames.length + ' 张都确认是本次上传的文件');
    }
  }
  if (verify.checked && verify.problems.length) {
    return {
      ok: false,
      reason: '选中的图不是本次上传的（命中了同名旧文件）—— 必须停下，不能提交',
      before,
      after,
      selected,
      confirmed,
      verify,
    };
  }

  return { ok: after.empty === 0, before, after, selected, confirmed, verify };
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
  const page = findPublishPage(context);
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
    // 只有 3:4 组能复用上传步骤留下的弹窗（它就是从 3:4 打开的）
    const result = await fillGroup(page, name, files, client, name === 'main34');
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

  // 【必须】把素材中心弹窗关干净再退出。
  // 上传那一步是"保留弹窗"（--keep-picker-open）交给这里复用的，
  // 如果这里用完不关，后面 SKU 颜色图/详情图会被这层浮层挡住——
  // 实测症状：SKU 那步找不到上传口、详情图报 "subtree intercepts pointer events"。
  // 光按 Escape 无效（焦点在 iframe 里），要先点一下页面空白处把焦点移出来。
  await page.mouse.click(120, 300).catch(() => {});
  await sleep(800);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);
  const leftovers = await page
    .evaluate(() => document.querySelectorAll('.next-overlay-wrapper.opened').length)
    .catch(() => -1);
  if (leftovers > 0) {
    // 再补一次，尽量清干净
    await page.mouse.click(120, 300).catch(() => {});
    await sleep(500);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(1200);
  }
  const after2 = await page
    .evaluate(() => document.querySelectorAll('.next-overlay-wrapper.opened').length)
    .catch(() => -1);
  console.log('收尾：关闭素材中心弹窗（剩余浮层 ' + after2 + '）');

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
