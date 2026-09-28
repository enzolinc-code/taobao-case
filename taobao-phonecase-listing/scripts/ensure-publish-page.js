#!/usr/bin/env node
'use strict';

// 保证桌面上有**一张**可用的发布页（没有就开一张空白发布页）。
//
// 为什么需要它（2026-09-28）：
//   - 上传步骤（bulk-upload-assets.js）必须有一张发布页才跑得起来（它要靠发布页进素材空间）；
//   - 提交成功后 submit-listing.js 会把那张发布页关掉；
//   - 所以在批量流程里，每一条开跑前都得确认发布页还在，否则第二条就会"没找到发布页"。
//   以前是靠人工在批量开始前开一张空白发布页，结果发布时流程又自己开一张，
//   桌面上就同时挂着两张发布页（用户看到"发布一个宝贝打开 2 次发布页"）。
//   现在改成：由这里统一保证"只有一张"，流程内部复用同一张。
//
// 用法: node ensure-publish-page.js [catId] [--force]
//   --force 无条件再开一张（正常不需要）

const path = require('path');
const { connect, sleep } = require('./lib/browser');

const CAT_ID = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '150704');
const FORCE = process.argv.includes('--force');

async function main() {
  const { context } = await connect();
  const publishPages = context.pages().filter((p) => p.url().includes('publish.htm'));

  if (!FORCE && publishPages.length) {
    console.log('已有发布页 ' + publishPages.length + ' 张，直接复用（不新开）');
    for (const p of publishPages) console.log('  - ' + p.url().slice(0, 110));
    process.exit(0);
  }

  const url = 'https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + CAT_ID;
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(9000);
  await page.bringToFront().catch(() => {});
  console.log('已打开发布页: ' + page.url().slice(0, 110));
  process.exit(0);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});
