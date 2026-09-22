#!/usr/bin/env node
'use strict';

// 顺序批量上新：逐条调用 pipeline-new-listing.js（8 步全流程），
// 任何一条失败立即停止，最后打印汇总并落一份 JSON 报告。
//
// 用法:
//   node batch-new-listing.js 011 012 013
//   node batch-new-listing.js --copy-from 1083698755183 --base D:\AutoTaobao\taobao-case 011 012
//
// 与 batch-publish.js 的区别：那个走 fill-listing.js（按 Excel 填属性/SKU），
// 这个走 pipeline-new-listing.js（复制模板 + 上传素材 + 换图 + 提交），是当前实际在用的路径。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(__dirname, 'pipeline-new-listing.js');

function parseArgs(argv) {
  const out = {
    copyFrom: '1083698755183',
    base: process.cwd(),
    out: '_listing-work',
    prefix: '商品-手机壳-',
    nums: [],
    // 透传给 pipeline-new-listing.js 的额外参数（例如 --upload-1x1 走"不调裁剪接口"的安全路径）
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--copy-from') out.copyFrom = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--upload-1x1') out.passthrough.push(a);
    else out.nums.push(a.replace(/^0+/, '').padStart(3, '0'));
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.nums.length) {
    console.error('用法: node batch-new-listing.js [--copy-from <id>] [--base <目录>] 011 012 ...');
    process.exit(1);
  }

  const base = path.resolve(args.base);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = { startedAt: new Date().toISOString(), copyFrom: args.copyFrom, base, items: [] };
  const todo = [...args.nums];

  for (const no of todo) {
    const dirName = args.prefix + no;
    const itemAbs = path.join(base, dirName, 'item.json');
    let design = '(读取配置失败)';
    try {
      design = JSON.parse(fs.readFileSync(itemAbs, 'utf8')).notes || '(无 notes)';
    } catch (e) {
      console.log('');
      console.log('⛔ ' + dirName + ' 的 item.json 读不到：' + e.message);
      summary.items.push({ no, dirName, design, ok: false, seconds: 0, error: '配置无法读取' });
      break;
    }

    console.log('');
    console.log('████████████████████████████████████████████████████████████');
    console.log('  批量进度 ' + (summary.items.length + 1) + '/' + todo.length + '  →  ' + no + '  ' + design);
    console.log('████████████████████████████████████████████████████████████');

    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [
        PIPELINE,
        '--item', path.join(dirName, 'item.json'),
        '--copy-from', args.copyFrom,
        '--upload', '--submit',
        '--out', args.out,
        ...args.passthrough,
      ],
      { cwd: base, stdio: 'inherit' }
    );
    const seconds = Math.round((Date.now() - t0) / 1000);
    const ok = r.status === 0;
    summary.items.push({ no, dirName, design, ok, seconds });
    console.log('');
    console.log((ok ? '✅ ' : '❌ ') + no + ' ' + design + '  ' + seconds + ' 秒');

    if (!ok) {
      const rest = todo.slice(summary.items.length);
      console.log('');
      console.log('⛔ 这一条失败，批量停止，避免带着问题继续往下发。');
      if (rest.length) {
        console.log('   修好后接着跑： node batch-new-listing.js ' + rest.join(' '));
      }
      break;
    }
  }

  summary.finishedAt = new Date().toISOString();
  const outDir = path.join(base, '_listing-work');
  fs.mkdirSync(outDir, { recursive: true });
  summary.file = path.join(outDir, 'batch-' + stamp + '.json');
  fs.writeFileSync(summary.file, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log('══════════ 批量汇总 ══════════');
  for (const it of summary.items) {
    console.log('  ' + (it.ok ? '✅' : '❌') + ' ' + it.no + '  ' + it.design + '  ' + it.seconds + ' 秒');
  }
  const done = summary.items.filter((i) => i.ok).length;
  console.log('  成功 ' + done + ' / ' + todo.length);
  console.log('  汇总文件: ' + summary.file);
  process.exit(summary.items.every((i) => i.ok) ? 0 : 1);
}

main();
