#!/usr/bin/env node
'use strict';

// 把 item.json 里配的标题写到当前打开的发布页上。
// 标题 = 图片目录名 + titleSuffix（没有 titleSuffix 就用 item.title）。
// 标题输入框是受控组件，必须真实键盘输入；写完回读校验。
//
// 用法: node set-listing-title.js --item <item.json>

const fs = require('fs');
const path = require('path');
const {
  connect,
  sleep,
  realType,
  screenshot,
  ensureDir,
  getArg,
  findPublishPage,
  detectRiskSignals,
} = require('./lib/browser');
const { effectiveTitle } = require('./lib/fill-core');

async function readTitle(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.sell-component-tbtitle-input input');
    return input ? String(input.value || '') : '';
  });
}

async function main() {
  const itemArg = getArg('item');
  if (!itemArg) {
    console.error('用法: node set-listing-title.js --item <item.json>');
    process.exit(1);
  }
  const itemPath = path.resolve(itemArg);
  if (!fs.existsSync(itemPath)) {
    console.error('找不到 ' + itemPath);
    process.exit(1);
  }
  const itemDir = path.dirname(itemPath);
  const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
  const title = effectiveTitle(item, itemDir);
  if (!title) {
    console.error('item.json 里既没有 title 也没有 titleSuffix');
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'title-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = findPublishPage(context);
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  const before = await readTitle(page);
  console.log('改前(' + Array.from(before).length + '): ' + before);
  console.log('目标(' + Array.from(title).length + '): ' + title);

  await realType(page, '.sell-component-tbtitle-input input', title, 0);
  await sleep(2500);

  const after = await readTitle(page);
  const ok = after === title;
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after-title');

  console.log('改后(' + Array.from(after).length + '): ' + after);
  console.log('写入: ' + (ok ? '成功' : '不一致'));
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('截图: ' + shot);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});
