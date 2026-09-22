#!/usr/bin/env node
'use strict';

// 从 read-reference-item.js 的输出里抽出一条 SKU 轴，生成/更新机型清单。
//
// 关键行为：如果目标清单已存在，**已有条目的 code / group / enabled 原样保留**。
// 重新生成不会让商家编码漂移——编码一旦变了，已上架商品的编码就对不上了。

const fs = require('fs');
const path = require('path');
const { getArg, readJson, writeJson, ensureDir } = require('./lib/browser');

function groupOf(name) {
  if (/^iPhone|^iPad/i.test(name)) return '苹果';
  if (/^华为/.test(name)) return '华为';
  if (/^荣耀/.test(name)) return '荣耀';
  if (/^小米|^红米/.test(name)) return '小米';
  if (/^OPPO/i.test(name)) return 'OPPO';
  if (/^vivo/i.test(name)) return 'vivo';
  if (/^一加/.test(name)) return '一加';
  if (/^iQOO|^iqoo/i.test(name)) return 'iQOO';
  if (/^三星/.test(name)) return '三星';
  return '其他';
}

// 用替换函数而不是 $1，避免任何 shell 把 $ 吃掉。
function codeOf(name) {
  if (/^iPhone/i.test(name)) {
    let body = name.replace(/^iPhone\s*/i, '').trim();
    if (/^air$/i.test(body)) return 'IP-AIR';
    body = body.replace(/\s+/g, '').toUpperCase();
    body = body.replace('PLUS', 'PL').replace('PROMAX', 'PM').replace('PRO', 'P');
    return 'IP-' + body;
  }
  if (/^华为/.test(name)) {
    let body = name
      .replace(/^华为\s*/, '')
      .replace(/\s+/g, '')
      .toUpperCase()
      .replace('NOVA', 'N')
      .replace('MATE', 'M')
      .replace('PURA', 'P')
      .replace('活力版', 'V');
    body = body
      .replace(/(\d+)PROMAX$/, (m, d) => d + 'PM')
      .replace(/(\d+)PRO\+$/, (m, d) => d + 'P+')
      .replace(/(\d+)PRO$/, (m, d) => d + 'P')
      .replace(/(\d+)ULTRA$/, (m, d) => d + 'U');
    return 'HW-' + body;
  }
  return 'OTHER';
}

function main() {
  const referencePath = getArg('reference');
  if (!referencePath) {
    console.error('用法: node model-list-from-reference.js --reference <reference.json> [--axis 适用手机型号] [--skip 2] [--out 机型清单.json]');
    console.error('--skip 表示 SKU 取值里前面有几个值属于别的轴（参考页有两个轴时通常是 2）。');
    process.exit(1);
  }

  const reference = readJson(path.resolve(referencePath));
  const values = (reference.page && reference.page.skuValues) || [];
  if (!values.length) {
    console.error('reference.json 里没有 skuValues，先跑 read-reference-item.js。');
    process.exit(1);
  }

  const axisName = getArg('axis') || '适用手机型号';
  const skip = Number(getArg('skip') || 2);
  const skipped = values.slice(0, skip);
  const names = [...new Set(values.slice(skip).map((v) => String(v).trim()).filter(Boolean))];
  if (!names.length) {
    console.error('--skip ' + skip + ' 之后没有剩下任何值，检查这个数字。');
    process.exit(1);
  }

  const outFile = path.resolve(getArg('out') || '机型清单.json');
  let existing = { axes: {} };
  if (fs.existsSync(outFile)) {
    try {
      existing = readJson(outFile);
    } catch {
      console.error('已有的 ' + outFile + ' 不是合法 JSON，先自己修一下再跑。');
      process.exit(1);
    }
  }
  const previous = new Map(
    ((existing.axes && existing.axes[axisName]) || []).map((entry) => [entry.name, entry])
  );

  const entries = names.map((name) => {
    const old = previous.get(name);
    if (old) return { ...old, name };
    return { name, code: codeOf(name), group: groupOf(name), enabled: true };
  });

  const axes = { ...(existing.axes || {}), [axisName]: entries };
  const output = {
    ...existing,
    _用法: '全店共用一份机型表。放在商品文件夹的上一级，item.json 用 axes 引用它。',
    _来源: '由 ' + path.basename(referencePath) + ' 的「' + axisName + '」轴生成。',
    updatedAt: new Date().toISOString().slice(0, 10),
    axes,
  };
  ensureDir(path.dirname(outFile));
  writeJson(outFile, output);

  const byGroup = {};
  for (const entry of entries) byGroup[entry.group] = (byGroup[entry.group] || 0) + 1;
  const added = entries.filter((entry) => !previous.has(entry.name)).length;
  const removed = [...previous.keys()].filter((name) => !names.includes(name));

  console.log('写入: ' + outFile);
  console.log('轴「' + axisName + '」共 ' + entries.length + ' 个值，其中新增 ' + added + ' 个');
  console.log('分组: ' + JSON.stringify(byGroup));
  if (skipped.length) console.log('跳过的前 ' + skip + ' 个值（属于别的轴）: ' + skipped.join(' / '));
  if (removed.length) {
    console.log('清单里有、本次参考页没有的型号（保留未删除，需要的话自己标 enabled:false）:');
    console.log('  ' + removed.slice(0, 20).join(' / ') + (removed.length > 20 ? ' …' : ''));
  }
  process.exit(0);
}

main();
