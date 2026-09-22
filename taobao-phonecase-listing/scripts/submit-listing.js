#!/usr/bin/env node
'use strict';

// 点「提交宝贝信息」提交当前发布页，并读回结果（跳转到 success.htm 或报错）。
//
// 用 CDP 真实鼠标事件点击 —— 这个页面对 Playwright 的 click 不认（事件委托）。
// 提交前会先打一次状态快照，方便追溯提交的是什么。
//
// 用法: node submit-listing.js [--dry-run] [--keep-open]
//   --keep-open  提交成功后不关闭页面（默认会关，避免标签页越堆越多）

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

async function cdpClickAt(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 20, y: y - 15, buttons: 0, pointerType: 'mouse' });
  await sleep(120);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(160);
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
    await sleep(140);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'submit-' + new Date().toISOString().replace(/[:.]/g, '-'));
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

  // 提交前的状态快照
  const snapshot = await page.evaluate(() => {
    const title = document.querySelector('.sell-component-tbtitle-input input');
    const model = document.getElementById('sell-field-p-20000~1');
    return {
      title: title ? String(title.value) : '',
      model: model && model.querySelector('input') ? String(model.querySelector('input').value) : '',
      mainImages: document.querySelectorAll('#struct-mainImagesGroup .drag-item img').length,
      main34Images: document.querySelectorAll('#struct-threeToFourImages .drag-item img').length,
      errorMarkers: Array.from(document.querySelectorAll('body *'))
        .filter((el) => /错误\s*[(（]\s*\d+\s*[)）]/.test(el.textContent || ''))
        .slice(0, 3)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)),
    };
  });
  console.log('提交前快照:');
  console.log('  标题: ' + snapshot.title.slice(0, 60) + '…');
  console.log('  型号: ' + snapshot.model);
  console.log('  主图: ' + snapshot.mainImages + ' + ' + snapshot.main34Images);
  if (snapshot.errorMarkers.length) {
    console.log('  ⚠️ 页面错误标记: ' + JSON.stringify(snapshot.errorMarkers));
  } else {
    console.log('  页面错误标记: 无');
  }

  if (dryRun) {
    console.log('（dry-run：不提交）');
    process.exit(0);
  }

  // 找提交按钮并滚进视口
  const button = page.locator('button').filter({ hasText: /^提交宝贝信息$/ }).first();
  if (!(await button.count())) {
    console.error('找不到「提交宝贝信息」按钮');
    process.exit(1);
  }
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1200);
  const box = await button.boundingBox();
  if (!box) {
    console.error('拿不到提交按钮坐标');
    process.exit(1);
  }
  console.log('提交按钮 @(' + Math.round(box.x + box.width / 2) + ',' + Math.round(box.y + box.height / 2) + ')');

  const client = await page.context().newCDPSession(page);
  await cdpClickAt(client, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  console.log('已点击提交，等待结果…');

  // 等跳转到 success.htm 或出现弹窗
  let result = null;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const url = page.url();
    if (url.includes('success.htm')) {
      await sleep(3000);
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      result = { kind: 'success', url, text: text.slice(0, 400) };
      break;
    }
    const dialogs = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('.next-dialog'))
          .map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200))
          .filter(Boolean)
      )
      .catch(() => []);
    if (dialogs.length) {
      result = { kind: 'dialog', url, dialogs };
      break;
    }
  }

  const risk = await detectRiskSignals(page);
  // 只有"没判定为成功"时才截图留证（成功路径不截，省算力）
  const shot = await screenshot(page, outDir, 'after-submit', {
    always: !(result && result.kind === 'success'),
  });
  fs.writeFileSync(
    path.join(outDir, 'submit-report.json'),
    JSON.stringify({ snapshot, result, risk, screenshot: shot }, null, 2),
    'utf8'
  );

  console.log('');
  if (!result) {
    console.log('20 次轮询后既没跳转成功页也没看到弹窗 —— 需要人工看页面');
  } else if (result.kind === 'success') {
    console.log('✅ 提交成功');
    // 评分是异步算的。老写法是硬等 25 秒再看——多数时候分数几秒内就出来了，白等十几秒。
    // 改成每秒看一眼，分数一出来就往下走；最多还是等 25 秒，所以最坏情况不比以前差。
    const scoreWaitStart = Date.now();
    const SCORE_CAP_MS = 25000;
    let finalText = result.text;
    let scoreMatch = null;
    let favorMatch = null;
    while (Date.now() - scoreWaitStart < SCORE_CAP_MS) {
      finalText = await page
        .evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
        .catch(() => finalText);
      scoreMatch = finalText.match(/基础分\s*(\d+)\s*分/);
      favorMatch = finalText.match(/扶优分\s*(\d+)\s*分/);
      if (scoreMatch) break;
      await sleep(1000);
    }
    console.log('   等分数用了 ' + Math.round((Date.now() - scoreWaitStart) / 1000) + ' 秒（老写法固定 25 秒）');
    if (scoreMatch) console.log('基础分: ' + scoreMatch[1] + ' 分');
    if (favorMatch) console.log('扶优分: ' + favorMatch[1] + ' 分');
    console.log(finalText.slice(0, 300));
    result.finalText = finalText;
    result.score = scoreMatch ? Number(scoreMatch[1]) : null;
    result.favorScore = favorMatch ? Number(favorMatch[1]) : null;
  } else {
    console.log('⚠️ 出现弹窗（可能需要人工确认或补填）:');
    result.dialogs.forEach((d) => console.log('  - ' + d));
  }
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);

  // 发布成功后关掉页面，避免标签页越堆越多（读完成绩再关）
  if (result && result.kind === 'success' && !process.argv.includes('--keep-open')) {
    await page.close().catch(() => {});
    console.log('已关闭发布页');
  }

  process.exit(result && result.kind === 'success' ? 0 : 1);
}

main().catch((err) => {
  console.error('提交失败: ' + err.message);
  process.exit(1);
});
