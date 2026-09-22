#!/usr/bin/env node
'use strict';

// 填详情页图：清空继承来的旧详情 → 点「图片」模块 → 一次勾选该商品的全部详情图 → 确定。
//
// 依据：
//   - 详情编辑器和主图用的是同一个素材中心（点「图片」按钮直接弹出来，实测）
//   - 素材中心支持多选，录屏里出现过「确定（8）」——8 张一次勾完，不用一张张加
//
// 用法: node fill-detail-images.js --dir <产品图片目录> [--keep-old] [--dry-run]
//   --keep-old  不清空原有详情（默认会清空，因为要换成自己的图）

const fs = require('fs');
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

// 素材中心弹窗是否开着。iframe 是常驻挂载的，必须同时判断外层浮层是打开的、且宽度正常
// （实测弹窗高度可能是 0，所以看宽度不看高度）。
function pickerOpen(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
        (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
      )
    )
    .catch(() => false);
}

function confirmDialogOpen(page) {
  // 注意：不能用 offsetParent 判断可见性 —— 这个确认弹窗是 position:fixed，
  // 而 fixed 元素的 offsetParent 恒为 null，会导致"弹窗明明开着却判成没开"，
  // 结果每次都白等满超时（实测每次浪费 5 秒，就是之前感觉到的卡顿）。
  // 改用"存在 + 占位尺寸 > 0"判断。
  return page
    .evaluate(() => {
      for (const d of document.querySelectorAll('.next-dialog')) {
        const r = d.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    })
    .catch(() => false);
}

async function readDetailState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('#panel_edit');
    if (!panel) return { error: 'no #panel_edit' };
    const images = Array.from(panel.querySelectorAll('img'))
      .map((img) => img.currentSrc || img.src || '')
      .filter((src) => /alicdn|taobao/.test(src));
    return {
      modules: panel.querySelectorAll('[class*="content_item"]').length,
      images: images.length,
    };
  });
}

async function clearOldDetail(page) {
  const clear = page.locator('#panel_edit button').filter({ hasText: /^清空$/ }).first();
  if (!(await clear.count())) return { cleared: false, reason: '没找到「清空」按钮' };
  const t0 = Date.now();
  await clear.click();
  // 等确认弹窗真的出现，而不是硬等 2 秒
  const appeared = await waitUntil(() => confirmDialogOpen(page), { timeoutMs: 5000, intervalMs: 200, minMs: 200 });
  console.log(
    '   清空：弹窗出现 ' + appeared.ms + ' ms' + (appeared.ok ? '' : '（超时，可能没有弹窗）')
  );
  // 确认弹窗
  const confirm = page.locator('.next-dialog button').filter({ hasText: /^确定$/ }).first();
  if (await confirm.count()) {
    await confirm.click().catch(() => {});
    // 等弹窗收掉
    const gone = await waitUntil(async () => !(await confirmDialogOpen(page)), { timeoutMs: 6000, intervalMs: 200, minMs: 300 });
    console.log('   清空：点确定后弹窗消失 ' + gone.ms + ' ms' + (gone.ok ? '' : '（超时！弹窗一直没消失）'));
    console.log('   清空：合计 ' + (Date.now() - t0) + ' ms');
    return { cleared: true };
  }
  return { cleared: false, reason: '清空后没出现确认按钮' };
}

// 在素材中心里按名字勾选多张
// 先切到「全部图片」根目录：上传的图都在那里；停在别的目录会看不到自己的图（实测）。
async function selectImagesByName(page, baseNames) {
  const frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (!frame) return { ok: false, reason: '素材中心 iframe 没出现', picked: [] };

  const sw = await switchToAllImages(page);
  console.log('  切到「全部图片」目录: ' + (sw.ok ? (sw.alreadyThere ? '本来就在（0 秒）' : sw.ms + ' ms') : '失败'));

  const picked = [];
  const missing = [];
  // 【效率】老写法：每张图都从列表头扫一遍，每个候选跟浏览器来回一次，
  // 8 张最多 320 次往返——实测"勾选 8 张"要 10.9 秒，其中大半耗在这。
  // 改成一次把整列名字读回来本地比对；每次点击后重读，列表重排也不会选错。
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

  for (const name of baseNames) {
    const labels = await readLabels();
    const index = labels.findIndex((t) => t && t.includes(name));
    if (index < 0) {
      missing.push(name);
      continue;
    }
    const wrappers = frame.locator('label.next-checkbox-wrapper');
    // 自定义复选框：真实 input 藏着，必须派发 DOM click
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
    await sleep(400);
  }
  return { ok: missing.length === 0, picked, missing };
}

async function confirmSelection(page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const scope of [page, ...page.frames()]) {
      const byFooter = scope.locator('button[class*="Footer_selectOk"]').first();
      if (await byFooter.count()) {
        const text = (await byFooter.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        await byFooter.click().catch(() => {});
        // 点完等弹窗收掉，不再硬等 4 秒
        await waitUntil(async () => !(await pickerOpen(page)), { timeoutMs: 8000, intervalMs: 300, minMs: 400 });
        return { confirmed: true, text };
      }
      const byDialog = scope.locator('.batch-fill-sku-image-dialog button, .next-dialog button').filter({ hasText: /^确定/ }).first();
      if (await dialogSafe(byDialog)) {
        const text = (await byDialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        await byDialog.click().catch(() => {});
        await waitUntil(async () => !(await pickerOpen(page)), { timeoutMs: 8000, intervalMs: 300, minMs: 400 });
        return { confirmed: true, text };
      }
    }
    await sleep(1500);
  }
  return { confirmed: false };
}

async function dialogSafe(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function main() {
  const dir = getArg('dir');
  if (!dir) {
    console.error('用法: node fill-detail-images.js --dir <产品图片目录> [--keep-old] [--dry-run]');
    process.exit(1);
  }
  const assets = loadAssets(dir, {});
  if (!assets.detail.length) {
    console.error('目录里没有详情图（详情图_N.jpg）');
    process.exit(1);
  }
  const baseNames = assets.detail.map((f) => path.basename(f).replace(/\.[^.]+$/, ''));

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'detail-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  // 分段计时：这一步之前有"卡顿"的反馈，先把时间花在哪量出来再优化
  const tStart = Date.now();
  const mark = (label) => console.log('   ⏱ ' + label + ': ' + ((Date.now() - tStart) / 1000).toFixed(1) + ' 秒');

  const before = await readDetailState(page);
  console.log('详情页当前: ' + JSON.stringify(before));
  console.log('要放入的详情图 ' + baseNames.length + ' 张: ' + baseNames.join(', '));
  mark('启动+读状态');

  if (process.argv.includes('--dry-run')) {
    console.log('（dry-run：不执行任何修改）');
    process.exit(0);
  }

  if (!process.argv.includes('--keep-old')) {
    const cleared = await clearOldDetail(page);
    console.log('清空旧详情: ' + JSON.stringify(cleared));
    mark('清空旧详情（含确认弹窗）');
    if (!cleared.cleared) {
      console.log('截图: ' + (await screenshot(page, outDir, 'clear-failed', { always: true })));
      process.exit(1);
    }
  }

  // 点「图片」模块 → 素材中心
  const imageButton = page.locator('#panel_edit [class*="add_item"]').filter({ hasText: /^图片$/ }).first();
  if (!(await imageButton.count())) {
    console.error('没找到详情区的「图片」模块按钮');
    process.exit(1);
  }
  await imageButton.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(600);
  await imageButton.click();
  // 等弹窗真的出来（老写法固定等 4.5 秒）
  const opened = await waitUntil(() => pickerOpen(page), { timeoutMs: 10000, intervalMs: 300, minMs: 500 });
  console.log('已点「图片」模块，弹窗出现用了 ' + opened.ms + ' ms' + (opened.ok ? '' : '（超时，仍继续）'));
  // 再等 iframe 内容就绪
  const detailContentReady = await waitForPickerContent(page, { timeoutMs: 8000 });
  if (!detailContentReady.ok) console.log('   ⚠️ 素材中心内容等超时了，仍继续');
  mark('打开素材中心');

  const selected = await selectImagesByName(page, baseNames);
  console.log('勾选结果: ' + JSON.stringify(selected));
  mark('勾选 8 张');
  if (!selected.picked.length) {
    console.log('截图: ' + (await screenshot(page, outDir, 'select-failed', { always: true })));
    process.exit(1);
  }

  const confirmResult = await confirmSelection(page);
  console.log('确认: ' + JSON.stringify(confirmResult));
  // 等详情模块数量发生变化（老写法固定等 4 秒）
  await waitUntil(
    async () => {
      const s = await readDetailState(page);
      return s && s.modules !== before.modules;
    },
    { timeoutMs: 8000, intervalMs: 400, minMs: 500 }
  );
  mark('确认+等详情刷新');

  const after = await readDetailState(page);
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after');
  fs.writeFileSync(
    path.join(outDir, 'detail-report.json'),
    JSON.stringify({ before, selected, confirmResult, after, risk, screenshot: shot }, null, 2),
    'utf8'
  );

  console.log('');
  console.log('详情页现在: ' + JSON.stringify(after));
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('=== 未提交商品。 ===');
  process.exit(after.images > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});
