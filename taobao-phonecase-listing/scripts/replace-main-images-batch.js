#!/usr/bin/env node
'use strict';

// 批量替换主图：按产品图片目录里的顺序，逐张调用 replace-main-image.js。
// 用子进程逐个跑，复用已经实测通过的那条路径，不另写一套。
//
// 用法:
//   node replace-main-images-batch.js --dir <产品图片目录> --container main --start 2
//   node replace-main-images-batch.js --dir <产品图片目录> --container main34 --start 1

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getArg } = require('./lib/browser');
const { loadAssets } = require('./load-listing-assets');

const CLI = path.join(__dirname, 'replace-main-image.js');
const GROUPS = { main: '主图', main34: '主图3比4' };

function sleep(ms) {
  // Node 里干净的同步等待，不依赖平台命令
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const dir = getArg('dir');
  const container = (getArg('container') || 'main').toLowerCase();
  const start = Number(getArg('start') || 1); // 从第几张开始（1 基）
  const limit = Number(getArg('limit') || 0);
  if (!dir || !GROUPS[container]) {
    console.error('用法: node replace-main-images-batch.js --dir <产品图片目录> --container main|main34 [--start N] [--limit N]');
    process.exit(1);
  }

  const assets = loadAssets(dir, {});
  const files = container === 'main' ? assets.main : assets.main34;
  if (!files.length) {
    console.error('目录里没有 ' + GROUPS[container] + ' 类的图');
    process.exit(1);
  }
  const queue = files.slice(start - 1, limit > 0 ? start - 1 + limit : undefined);

  console.log('=== ' + GROUPS[container] + '：计划替换 ' + queue.length + ' 张（从第 ' + start + ' 张开始）');
  const results = [];

  for (let i = 0; i < queue.length; i++) {
    const slotIndex = start + i; // 槽位序号，1 基
    const file = queue[i];
    console.log('');
    console.log('--- [' + (i + 1) + '/' + queue.length + '] 槽位 ' + slotIndex + ' ← ' + path.basename(file));

    const run = spawnSync(
      process.execPath,
      [CLI, '--container', container, '--index', String(slotIndex), '--file', file],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    const output = ((run.stdout || '') + (run.stderr || '')).trim();
    // 只打印关键行，避免刷屏
    output
      .split('\n')
      .filter((line) => /菜单项|替换前|替换后|图片已更换|失败|没有|找不到|风控/.test(line))
      .forEach((line) => console.log('    ' + line.trim()));

    const ok = run.status === 0;
    results.push({ slot: slotIndex, file, ok });
    console.log('    → ' + (ok ? '成功' : '失败'));
    if (!ok) {
      console.log('    中断本组，先查失败原因');
      break;
    }
    if (i < queue.length - 1) sleep(3000);
  }

  console.log('');
  console.log('=== 小结 ===');
  results.forEach((r) => console.log('  槽位 ' + r.slot + ' ' + path.basename(r.file) + ' : ' + (r.ok ? '成功' : '失败')));
  const failed = results.filter((r) => !r.ok).length;
  console.log('成功 ' + (results.length - failed) + ' / ' + results.length);
  console.log('=== 只替换了图片，没有提交。 ===');
  process.exit(failed ? 1 : 0);
}

main();
