'use strict';

// 从「上架台账.md」导出一份 ID 清单（CSV + 逗号分隔 txt），给用户拿去别处用。
//
// 用法:
//   node export-ids.js --date 9/24            # 只导某一上架日（台账里的日期写法，如 9/24）
//   node export-ids.js --since 340            # 从某个编号起（含）
//   node export-ids.js --since 340 --tag 最近
//
// 产物:
//   导出-ID-<tag>.csv   （Excel 可直接打开，UTF-8 带 BOM，列：编号/商品ID/设计/上架日）
//   导出-ID-<tag>.txt   （逗号分隔，方便整段粘贴）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER = path.join(ROOT, '上架台账.md');
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] != null ? args[i + 1] : fallback;
};

const dateFilter = getArg('date', null);
const sinceNo = getArg('since', null);
const tag = getArg('tag', dateFilter ? dateFilter.replace('/', '-') : 'since-' + (sinceNo || 'all'));

const rows = [];
for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
  // | 340 | 1084890895830 | M0619艺术扑克顺子 | 9/24 | 72 | ✅ | ✅ 干净 | 100 |
  const m = line.match(/^\|\s*(\d+)\s*\|\s*\*{0,2}(\d{9,})\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
  if (!m) continue;
  rows.push({ no: Number(m[1]), id: m[2], design: m[3].trim(), date: m[4].trim() });
}
rows.sort((a, b) => a.no - b.no);

let picked = rows;
if (dateFilter) picked = picked.filter((r) => r.date === dateFilter);
if (sinceNo) {
  const from = Number(String(sinceNo).replace(/^0+/, ''));
  picked = picked.filter((r) => r.no >= from);
}

if (!picked.length) {
  console.error('没有匹配的记录（检查 --date / --since）');
  process.exit(1);
}

const csvFile = path.join(ROOT, '导出-ID-' + tag + '.csv');
const txtFile = path.join(ROOT, '导出-ID-' + tag + '.txt');

const csv = ['编号,商品ID,设计,上架日']
  .concat(picked.map((r) => [r.no, r.id, '"' + r.design.replace(/"/g, '""') + '"', r.date].join(',')))
  .join('\r\n');
// 带 BOM，Excel 打开中文不乱码
fs.writeFileSync(csvFile, '\ufeff' + csv + '\r\n', 'utf8');
fs.writeFileSync(txtFile, picked.map((r) => r.id).join(','), 'utf8');

console.log('导出 ' + picked.length + ' 条（#' + picked[0].no + '–#' + picked[picked.length - 1].no + '）');
console.log('  ' + csvFile);
console.log('  ' + txtFile);
console.log('');
console.log(picked.map((r) => r.id).join(','));
