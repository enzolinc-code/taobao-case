#!/usr/bin/env node
'use strict';

// 把 read-sku-template.py 解析出的结构，转成全店共用的机型清单。
// 已有条目的 code / group / enabled 会保留，重复生成不会让商家编码漂移。
//
// 用法: node model-list-from-template.js --structure structure.json --out 机型清单.json

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
  return '其他';
}

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

// 颜色编码：优先用括号里的卖点（亮面/磨砂/磁吸），拿不到就自己编
function colorCodeOf(name, index) {
  const bracket = name.match(/[（(]([^）)]+)[）)]/);
  if (bracket) {
    const inner = bracket[1].trim();
    const map = { 亮面: 'GLOSS', 磨砂: 'MATTE', 磁吸: 'MAG', 光面: 'GLOSS', 透明: 'CLR' };
    if (map[inner]) return map[inner];
    return inner.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'C' + (index + 1);
  }
  return 'C' + (index + 1);
}

function main() {
  const structurePath = getArg('structure');
  if (!structurePath) {
    console.error('用法: node model-list-from-template.js --structure <structure.json> [--out 机型清单.json]');
    process.exit(1);
  }
  const structure = readJson(path.resolve(structurePath));
  const models = structure.models || [];
  const colorNames = Object.keys(structure.colorCounts || {});
  if (!models.length) {
    console.error('structure.json 里没有 models');
    process.exit(1);
  }

  const outFile = path.resolve(getArg('out') || '机型清单.json');
  let existing = { axes: {} };
  if (fs.existsSync(outFile)) {
    try {
      existing = readJson(outFile);
    } catch {
      console.error(outFile + ' 不是合法 JSON');
      process.exit(1);
    }
  }

  const previousModels = new Map(
    ((existing.axes && existing.axes['适用手机型号']) || []).map((e) => [e.name, e])
  );
  const previousColors = new Map(
    ((existing.axes && existing.axes['颜色分类']) || []).map((e) => [e.name, e])
  );

  const modelEntries = models.map((name) => {
    const old = previousModels.get(name);
    return old ? { ...old, name } : { name, code: codeOf(name), group: groupOf(name), enabled: true };
  });
  const colorEntries = colorNames.map((name, index) => {
    const old = previousColors.get(name);
    return old ? { ...old, name } : { name, code: colorCodeOf(name, index), group: '款式', enabled: true };
  });

  const output = {
    ...existing,
    _用法: '全店共用一份机型表。放在商品文件夹的上一级，item.json 用 axes 引用它。',
    _来源: '由 ' + path.basename(structurePath) + ' 生成（来自商品自身 SKU 模板）。',
    updatedAt: new Date().toISOString().slice(0, 10),
    axes: { ...(existing.axes || {}), 适用手机型号: modelEntries, 颜色分类: colorEntries },
  };
  ensureDir(path.dirname(outFile));
  writeJson(outFile, output);

  const added = modelEntries.filter((e) => !previousModels.has(e.name)).length;
  console.log('写入: ' + outFile);
  console.log('机型 ' + modelEntries.length + ' 个（新增 ' + added + '）');
  console.log('颜色 ' + colorEntries.length + ' 个: ' + colorEntries.map((c) => c.name + '(' + c.code + ')').join(' / '));
  process.exit(0);
}

main();
