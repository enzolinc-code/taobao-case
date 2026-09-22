#!/usr/bin/env node
'use strict';

// 把产品图片目录里的图上传到发布页对应位置。
//
// 这个流程来自真人录屏（_listing-work/recording-3），七步缺一不可：
//   1. 点上传槽                div.drag-item:nth-of-type(1) ... .upload-text
//   2. iframe 里点「本地上传」  button.next-btn-primary
//   3. 点 #sucai-tu-upload     触发原生文件选择框
//   4. 选文件
//   5. 点「完成」              .UploadPanel_footerBtn —— 把图存进图片空间并返回列表
//   6. 回到列表里勾选那张图     label.next-checkbox-wrapper > input.next-checkbox-input
//   7. 点弹窗底部的「确定（N）」 .Footer_selectOk —— 这一步才真正落到槽位上
// 第 6、7 步是最容易漏的：做到第 5 步，图进了图片空间但槽位还是空的；
// 只勾选不点「确定（N）」，同样不生效。
//
// 每个槽位容量是 1（iframe URL 带 max=1），所以一个槽一张图地传。
//
// 用法: node upload-listing-images.js --dir <产品图片目录> --group main|main34|all [--limit N] [--pick-only]
//
// --pick-only：图已经在图片空间里了（用 bulk-upload-assets.js 整批传过），
//   这次只按文件名挑、不重新上传。比默认模式快很多。

const fs = require('fs');
const path = require('path');
const { connect, sleep, screenshot, ensureDir, getArg, detectRiskSignals } = require('./lib/browser');
const { loadAssets } = require('./load-listing-assets');

const CONTAINERS = {
  main: { selector: '#struct-mainImagesGroup', label: '1:1 主图', slot: '.main-content.medium.dashed' },
  main34: { selector: '#struct-threeToFourImages', label: '3:4 主图', slot: '.main-content.medium.dashed' },
};

const SELECTOR_IFRAME = 'sucai-selector-ng';

// 最后一张图传完后页面会重渲染，素材中心的 iframe 会被重建。
// 继续用旧引用就会报 "Frame was detached" —— 但图其实已经上去了（实测踩了两次）。
// 所以这里统一用这个带重试的取 frame 函数，拿到的一定是当前活着的那个。
async function getSucaiFrame(page, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const frames = page.frames().filter((f) => f.url().includes(SELECTOR_IFRAME));
    for (const frame of frames.reverse()) {
      try {
        await frame.evaluate(() => 1);
        return frame;
      } catch {
        // 这个 frame 已经废了，试下一个
      }
    }
    await sleep(1500);
  }
  return null;
}

async function countImages(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return { error: '找不到容器 ' + sel };
    const images = Array.from(node.querySelectorAll('img'))
      .map((img) => img.currentSrc || img.src || '')
      .filter((src) => src && /alicdn|taobao/.test(src));
    return {
      images: images.length,
      emptySlots: node.querySelectorAll('.main-content.medium.dashed').length,
      sample: images.slice(0, 2),
    };
  }, selector);
}

async function closeModal(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1200);
}

// 第 6 步：回列表里勾选目标图。优先按文件名匹配，匹配不到就用第一张（列表最新的在最前）。
// frame 会在上传完最后一张后被重建，所以内部要能重新获取，不能一直捏着旧引用。
async function checkImageInLibrary(page, baseName) {
  let frame = await getSucaiFrame(page);
  if (!frame) return { ok: false, reason: '素材中心 iframe 已消失' };
  let wrappers = frame.locator('label.next-checkbox-wrapper');
  if (!(await wrappers.count())) return { ok: false, reason: '列表里没有可勾选的图' };

  // 必须先等这张图渲染出来。上传完立刻勾选会点空（或勾到别的图），
  // 表现就是"全流程走完但槽位没变"——这个坑踩过两次。
  let index = -1;
  for (let attempt = 0; attempt < 15 && index < 0; attempt++) {
    const total = await wrappers.count();
    for (let i = 0; i < Math.min(total, 30); i++) {
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
      if (baseName && text && text.includes(baseName)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      await sleep(2000);
      // frame 被重建时重新获取，否则后面的操作全打在死引用上
      const refreshed = await getSucaiFrame(page, 2);
      if (refreshed) {
        frame = refreshed;
        wrappers = frame.locator('label.next-checkbox-wrapper');
      }
    }
  }
  if (index < 0) {
    console.log('    列表里没出现「' + baseName + '」，退回第一张');
    index = 0;
  }

  const checkedBefore = await frame.evaluate(() => document.querySelectorAll('input[type=checkbox]:checked').length).catch(() => -1);
  const input = wrappers.nth(index).locator('input.next-checkbox-input').first();
  // 复选框是自定义组件，真实 input 被藏起来，Playwright 的 click 会报"元素不可见"。
  // 直接派发 DOM click，页面自己的事件处理能收到。
  if (await input.count()) {
    await input
      .evaluate((el) => {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })
      .catch(async () => {
        const refreshed = await getSucaiFrame(page, 2);
        if (!refreshed) return;
        const again = refreshed.locator('label.next-checkbox-wrapper').nth(index).locator('input.next-checkbox-input').first();
        if (await again.count()) {
          await again.evaluate((el) => {
            el.click();
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
      });
  } else {
    await wrappers.nth(index).evaluate((el) => el.click()).catch(() => {});
  }
  await sleep(2000);
  const finalFrame = (await getSucaiFrame(page, 2)) || frame;
  const checkedAfter = await finalFrame.evaluate(() => document.querySelectorAll('input[type=checkbox]:checked').length).catch(() => -1);
  return { ok: true, index, checkedBefore, checkedAfter, matchedBy: index === 0 ? '第一张（最新）' : '文件名匹配' };
}

// 第 7 步：弹窗底部的「确定（N）」。这是真正让图片落到槽位上的那一下。
async function confirmIfPresent(page) {
  // 文案形如「确定（1）」，class 里带 Footer_selectOk，优先按 class 找，再退回文案匹配
  // 按钮是条件渲染的，勾选之后才出现，所以要轮询等（最多 20 秒）。
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const scope of [page, ...page.frames()]) {
      const byClass = scope.locator('button[class*="Footer_selectOk"]').first();
      if (await byClass.count()) {
        await byClass.click().catch(() => {});
        await sleep(3000);
        return { clicked: true, via: 'Footer_selectOk' };
      }
      const byText = scope.locator('button').filter({ hasText: /^确定（\d+）$/ }).first();
      if (await byText.count()) {
        await byText.click().catch(() => {});
        await sleep(3000);
        return { clicked: true, via: '确定（N）' };
      }
    }
    await sleep(2000);
  }
  return { clicked: false };
}

// 传一张图到一个槽位：开弹窗 → iframe 里本地上传 → 完成
async function uploadOne(page, container, file) {
  const scope = page.locator(container.selector).first();
  const slot = scope.locator(container.slot).first();
  if (!(await slot.count())) return { ok: false, reason: '没有空的上传槽' };

  const before = await countImages(page, container.selector);

  await slot.click();
  await sleep(4000);

  let frame = await getSucaiFrame(page);
  if (!frame) {
    await closeModal(page);
    return { ok: false, reason: '弹窗里没出现素材中心 iframe' };
  }

  const pickOnly = process.argv.includes('--pick-only');
  const baseName = path.basename(file).replace(/\.[^.]+$/, '');

  if (!pickOnly) {
  // 第 2 步：本地上传
  const localUpload = frame.locator('button:has-text("本地上传")').first();
  if (!(await localUpload.count())) {
    await closeModal(page);
    return { ok: false, reason: 'iframe 里没找到「本地上传」按钮' };
  }
  await localUpload.click();
  await sleep(2500);

  // 第 3、4 步：点上传区触发文件框，塞文件
  let trigger;
  try {
    const uploadArea = frame.locator('#sucai-tu-upload').first();
    const clickTarget = (await uploadArea.count()) ? uploadArea : frame.locator('input[type=file]').first();
    if (await clickTarget.count()) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 20000 }),
        clickTarget.click(),
      ]);
      trigger = { chooser };
    }
  } catch (err) {
    await closeModal(page);
    return { ok: false, reason: '文件选择框没出现: ' + String(err.message || err).split('\n')[0] };
  }
  if (!trigger) {
    await closeModal(page);
    return { ok: false, reason: 'iframe 里没找到上传触发点' };
  }
  await trigger.chooser.setFiles([file]);

  // 等平台把图传到图片空间
  await sleep(14000);

  // 第 5 步：完成
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  const done = frame ? frame.locator('button:has-text("完成")').first() : null;
  if (done && (await done.count())) {
    await done.click();
    await sleep(6000);
  }
  }

  // 第 6 步：回列表勾选（漏了这步，图只进图片空间、槽位还是空的）
  frame = await getSucaiFrame(page);
  if (!frame) {
    await closeModal(page);
    return { ok: false, reason: '第 5 步之后 iframe 就没了，没法勾选' };
  }
  const picked = await checkImageInLibrary(page, baseName);
  await confirmIfPresent(page);
  await sleep(2500);

  // 点完「完成」不等于图片真的落到槽位上——必须回读空槽数量，
  // 空槽没减少就是没生效。这一条一开始写成"只要点成功就返回 true"，误报过。
  const after = await countImages(page, container.selector);
  if (after.emptySlots < before.emptySlots) {
    return { ok: true, emptySlots: after.emptySlots, picked };
  }
  return {
    ok: false,
    reason: '走完全流程但空槽数没变（' + before.emptySlots + ' → ' + after.emptySlots + '）',
    picked,
    after,
  };
}

async function main() {
  const dir = getArg('dir');
  const group = (getArg('group') || 'all').toLowerCase();
  const limit = Number(getArg('limit') || 0);
  const start = Number(getArg('start') || 0);
  if (!dir) {
    console.error('用法: node upload-listing-images.js --dir <产品图片目录> --group main|main34|all [--limit N]');
    process.exit(1);
  }

  const assets = loadAssets(dir, {});
  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'upload-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const targets = [];
  if ((group === 'all' || group === 'main') && assets.main.length) targets.push(['main', assets.main]);
  if ((group === 'all' || group === 'main34') && assets.main34.length) targets.push(['main34', assets.main34]);
  if (!targets.length) {
    console.error('没有要上传的图。1:1主图 ' + assets.main.length + ' 张，3:4主图 ' + assets.main34.length + ' 张');
    process.exit(1);
  }

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('copyItem=true'));
  if (!page) {
    console.error('没找到 copyItem 发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await closeModal(page);

  const log = [];
  for (const [name, files] of targets) {
    const container = CONTAINERS[name];
    const queue = limit > 0 ? files.slice(start, start + limit) : files.slice(start);
    console.log('=== ' + container.label + '：计划上传 ' + queue.length + ' 张');
    const before = await countImages(page, container.selector);
    console.log('    起始状态: 已有图 ' + before.images + '，空槽 ' + before.emptySlots);

    for (let i = 0; i < queue.length; i++) {
      const file = queue[i];
      const result = await uploadOne(page, container, file);
      console.log(
        '    [' + (i + 1) + '/' + queue.length + '] ' + path.basename(file) + ' → ' +
          (result.ok ? '成功' : '失败: ' + result.reason)
      );
      log.push({ group: name, file, ...result });
      const state = await countImages(page, container.selector);
      console.log('        现在已有图 ' + state.images + '，空槽 ' + state.emptySlots);
      if (!result.ok) {
        console.log('    中断这个分组，避免继续污染页面');
        break;
      }
      await sleep(1500);
    }
  }

  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after-upload');
  const report = { generatedAt: new Date().toISOString(), dir: path.resolve(dir), log, risk, screenshot: shot };
  const reportPath = path.join(outDir, 'upload-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  console.log('报告: ' + reportPath);
  console.log('=== 只上传图片，没有提交。 ===');
  process.exit(log.some((entry) => !entry.ok) ? 1 : 0);
}

main().catch((err) => {
  console.error('上传失败: ' + err.message);
  process.exit(1);
});
