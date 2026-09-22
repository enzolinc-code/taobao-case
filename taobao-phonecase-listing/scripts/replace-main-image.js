#!/usr/bin/env node
'use strict';

// 替换 1:1 或 3:4 主图的第 N 张。
//
// 关键：槽位操作菜单（裁剪/替换/删除/AI 作图）**只在真实鼠标轨迹下出现**，
// Playwright 的 hover() 触发不了（前端用了事件委托）。所以这里用 CDP 的
// Input.dispatchMouseEvent 派发一串 mouseMoved，模拟人手的移动轨迹。
//
// 用法: node replace-main-image.js --container main --index 1 --file <图片路径>
//   --container main   → 1:1 主图（#struct-mainImagesGroup）
//   --container main34 → 3:4 主图（#struct-threeToFourImages）

const fs = require('fs');
const path = require('path');
const {
  connect,
  sleep,
  screenshot,
  ensureDir,
  getArg,
  detectRiskSignals,
} = require('./lib/browser');

const CONTAINERS = {
  main: { selector: '#struct-mainImagesGroup', label: '1:1 主图' },
  main34: { selector: '#struct-threeToFourImages', label: '3:4 主图' },
};

const SELECTOR_IFRAME = 'sucai-selector-ng';

async function readSlots(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return { error: '找不到 ' + sel };
    const items = Array.from(node.querySelectorAll('.drag-item'));
    return {
      count: items.length,
      empty: node.querySelectorAll('.main-content.medium.dashed').length,
      // 每个槽位首图地址的后半段，用来看有没有换掉
      srcs: items.map((item) => {
        const img = item.querySelector('img');
        return img ? (img.currentSrc || img.src || '').slice(-45) : null;
      }),
    };
  }, selector);
}

async function mousePath(client, points) {
  for (const [x, y] of points) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      buttons: 0,
      pointerType: 'mouse',
    });
    await sleep(110);
  }
}

// 用真实轨迹悬停槽位，然后读出菜单里每一项的坐标
async function openSlotMenu(page, client, containerSelector, index) {
  const slot = page.locator(containerSelector + ' .drag-item').nth(index);
  await slot.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(600);

  const box = await slot.boundingBox();
  if (!box) return { error: '拿不到槽位坐标' };
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  await mousePath(client, [
    [cx - 160, cy - 120],
    [cx - 90, cy - 60],
    [cx - 30, cy - 20],
    [cx, cy],
    [cx + 2, cy + 1],
    [cx, cy],
  ]);
  await sleep(2200);

  const menu = await page.evaluate((sel) => {
    const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
    const container = document.querySelector(sel);
    const box = container ? container.getBoundingClientRect() : null;
    const items = [];
    document.querySelectorAll('li.next-menu-item').forEach((li) => {
      const text = textOf(li);
      const rect = li.getBoundingClientRect();
      if (rect.width < 2) return;
      const cyy = rect.top + rect.height / 2;
      if (box && (cyy < box.top - 200 || cyy > box.bottom + 200)) return;
      items.push({ text, x: Math.round(rect.left + rect.width / 2), y: Math.round(cyy) });
    });
    return items;
  }, containerSelector);

  return { box, center: { cx, cy }, menu };
}

async function main() {
  const containerKey = (getArg('container') || 'main').toLowerCase();
  const index = Number(getArg('index') || 1) - 1;
  const file = getArg('file');
  if (!file) {
    console.error('用法: node replace-main-image.js --container main --index 1 --file <图片路径>');
    process.exit(1);
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error('找不到图片: ' + filePath);
    process.exit(1);
  }
  const container = CONTAINERS[containerKey];
  if (!container) {
    console.error('--container 只能是 main 或 main34');
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'replace-' + new Date().toISOString().replace(/[:.]/g, '-'));
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

  const client = await page.context().newCDPSession(page);
  const before = await readSlots(page, container.selector);
  console.log('替换前 ' + container.label + ': 槽位 ' + before.count + '，空槽 ' + before.empty + '，第 ' + (index + 1) + ' 张 = ' + before.srcs[index]);

  const opened = await openSlotMenu(page, client, container.selector, index);
  if (opened.error) {
    console.error(opened.error);
    process.exit(1);
  }
  console.log('菜单项: ' + JSON.stringify(opened.menu.map((m) => m.text + '@(' + m.x + ',' + m.y + ')')));

  const replaceItem = opened.menu.find((m) => m.text === '替换');
  if (!replaceItem) {
    console.error('菜单里没有「替换」，截图留证');
    console.log(await screenshot(page, outDir, 'no-replace'));
    process.exit(1);
  }

  // 用 CDP 点击，保持和悬停同一套输入通道
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: replaceItem.x,
      y: replaceItem.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await sleep(120);
  }
  console.log('已点「替换」，等待选择图片弹窗');
  await sleep(4500);

  let frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (!frame) {
    console.error('没出现素材中心 iframe');
    process.exit(1);
  }

  const localUpload = frame.locator('button:has-text("本地上传")').first();
  if (await localUpload.count()) {
    await localUpload.click();
    await sleep(2500);
  }

  const uploadArea = frame.locator('#sucai-tu-upload').first();
  const clickTarget = (await uploadArea.count()) ? uploadArea : frame.locator('input[type=file]').first();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    clickTarget.click(),
  ]);
  await chooser.setFiles([filePath]);
  console.log('已投递文件，等待上传…');
  await sleep(14000);

  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  const done = frame ? frame.locator('button:has-text("完成")').first() : null;
  if (done && (await done.count())) {
    await done.click();
    await sleep(6000);
  }

  // 勾选刚上传的那张
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  if (frame) {
    const baseName = path.basename(file).replace(/\.[^.]+$/, '');
    const wrappers = frame.locator('label.next-checkbox-wrapper');
    // 等这张图真正出现在列表里（最多 30 秒）。上传完立刻点会点空，
    // 表现为"勾了但没生效"——这个坑踩过两次。
    let picked = -1;
    for (let attempt = 0; attempt < 15 && picked < 0; attempt++) {
      const total = await wrappers.count();
      for (let i = 0; i < Math.min(total, 20); i++) {
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
        if (text && text.includes(baseName)) { picked = i; break; }
      }
      if (picked < 0) await sleep(2000);
    }
    if (picked < 0) {
      console.log('列表里始终没出现「' + baseName + '」，退回第一张');
      picked = 0;
    }

    const checkedBefore = await frame.evaluate(() => document.querySelectorAll('input[type=checkbox]:checked').length);
    const input = wrappers.nth(picked).locator('input.next-checkbox-input').first();
    // 复选框是自定义组件，真实 input 被藏起来，Playwright 的 click 会报"元素不可见"。
    // 直接派发 DOM click，页面自己的事件处理能收到——这一步实测有效。
    if (await input.count()) {
      await input.evaluate((el) => {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await sleep(2000);
    const checkedAfter = await frame.evaluate(() => document.querySelectorAll('input[type=checkbox]:checked').length);
    console.log('勾选: ' + checkedBefore + ' → ' + checkedAfter + '（第 ' + picked + ' 张）');
  }

  // 点「确定（N）」。按钮是条件渲染的，轮询等它出现（最多 20 秒）。
  let confirmed = null;
  for (let attempt = 0; attempt < 10 && !confirmed; attempt++) {
    for (const scope of [page, ...page.frames()]) {
      const byClass = scope.locator('button[class*="Footer_selectOk"]').first();
      if (await byClass.count()) {
        const text = await byClass.innerText().catch(() => '');
        await byClass.click().catch(() => {});
        confirmed = text.replace(/\s+/g, ' ').trim() || 'Footer_selectOk';
        break;
      }
    }
    if (!confirmed) await sleep(2000);
  }
  console.log('点确定: ' + (confirmed || '没找到确认按钮'));
  await sleep(3500);

  const after = await readSlots(page, container.selector);
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after-replace');
  const changed = before.srcs[index] !== after.srcs[index];

  console.log('');
  console.log('替换后: 槽位 ' + after.count + '，第 ' + (index + 1) + ' 张 = ' + after.srcs[index]);
  console.log('图片已更换: ' + (changed ? '是' : '否'));
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('=== 只替换了图片，没有提交。 ===');
  process.exit(changed ? 0 : 1);
}

main().catch((err) => {
  console.error('替换失败: ' + err.message);
  process.exit(1);
});
