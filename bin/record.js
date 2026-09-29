#!/usr/bin/env node
'use strict';

// 记账：回收本轮提交的 ID → 重建 ID 清单 →（可选）写回台账 →（可选）git 提交推送。
//
// 用法:
//   node bin/record.js --since 630                 # 只回收 + 重建清单 + 打印台账行
//   node bin/record.js --since 630 --write         # 顺带把台账行写进 上架台账.md
//   node bin/record.js --since 630 --write --push  # 再 git 提交并推送

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const SINCE = argOf('--since');
const WRITE = has('--write');
const PUSH = has('--push');
const MINUTES = argOf('--minutes', '300');

if (!SINCE) {
  console.error('用法: node bin/record.js --since <起始编号> [--write] [--push]');
  process.exit(1);
}

const shop = readJson(path.join(ROOT, 'config', 'shop.json'));
const ledgerPath = path.join(ROOT, shop.paths.ledger);

// 1) 回收 ID
const collect = spawnSync(process.execPath, [
  path.join(ROOT, shop.paths.workDir, 'collect-submit-ids.js'),
  '--since', String(SINCE),
  '--minutes', String(MINUTES),
  '--md',
], { encoding: 'utf8' });
const out = (collect.stdout || '') + (collect.stderr || '');
const rows = out.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|\s*\d{9,}\s*\|/.test(l));
if (!rows.length) {
  console.log('没有回收到新的提交报告（可能都还没跑完，或报告目录里没有匹配项）。');
  console.log(out.slice(0, 600));
  process.exit(1);
}
console.log('回收到 ' + rows.length + ' 条：');
rows.forEach((r) => console.log('  ' + r));

// 2) 写回台账
if (WRITE) {
  let text = fs.readFileSync(ledgerPath, 'utf8');
  const have = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) have.add(Number(m[1]));
  }
  const fresh = rows.filter((r) => !have.has(Number(r.match(/^\|\s*(\d+)/)[1])));
  if (!fresh.length) {
    console.log('台账里已经有这些编号，未重复写入。');
  } else {
    const anchor = text.match(/\n\*\*表格共 \d+ 编号/);
    if (!anchor) {
      console.error('没找到台账的插入锚点（"**表格共 N 编号"那一行），请手工粘贴：');
      fresh.forEach((r) => console.log('  ' + r));
      process.exit(1);
    }
    text = text.replace(anchor[0], '\n' + fresh.join('\n') + anchor[0]);
    fs.writeFileSync(ledgerPath, text, 'utf8');
    console.log('已把 ' + fresh.length + ' 行写入 ' + shop.paths.ledger + '（记得核对"表格共 N 编号/在架 N 条"那行的数字）');
  }
}

// 3) 重建 ID 清单
spawnSync(process.execPath, [path.join(ROOT, shop.paths.workDir, 'build-id-lists.js')], { stdio: 'inherit' });

// 4) git
if (PUSH) {
  const msg = argOf('--message', 'record: 更新台账与 ID 清单（起始 #' + SINCE + '）');
  const git = (a) => spawnSync('git', ['-c', 'safe.directory=' + ROOT.split(path.sep).join('/'), ...a], { cwd: ROOT, stdio: 'inherit' });
  git(['add', shop.paths.ledger, '上架ID-逐行.txt', '上架ID-逗号分隔.txt']);
  git(['commit', '-m', msg]);
  git(['push', 'origin', 'main']);
}
process.exit(0);
