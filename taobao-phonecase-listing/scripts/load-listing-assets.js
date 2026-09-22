#!/usr/bin/env node
'use strict';

// 读取一个产品图片目录，按命名规则把四类图归位，并做自检。
// 目录名 = 标题前缀。不碰浏览器，可以放心反复跑。

const fs = require('fs');
const path = require('path');
const { getArg, readJson } = require('./lib/browser');
const modelRegistry = require('./lib/model-registry');

// 「主图3比4_」必须在「主图_」之前匹配（虽然 主图3比4_01 并不以 主图_ 开头，但顺序明确更稳）
const GROUPS = [
  { key: 'main34', prefix: '主图3比4_', label: '3:4 主图', max: 5 },
  { key: 'main', prefix: '主图_', label: '1:1 主图', max: 5, required: true },
  { key: 'sku', prefix: 'SKU_', label: 'SKU 颜色图' },
  { key: 'detail', prefix: '详情图_', label: '详情页图', required: true },
];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function naturalSort(a, b) {
  const numA = Number((a.match(/(\d+)(?=\.[^.]+$)/) || [])[1] || 0);
  const numB = Number((b.match(/(\d+)(?=\.[^.]+$)/) || [])[1] || 0);
  if (numA !== numB) return numA - numB;
  return a.localeCompare(b, 'zh-CN');
}

// 颜色轴：优先找名为「颜色分类」的轴，否则取取值最少的那个轴
function colorAxis(item, itemDir) {
  const resolved = modelRegistry.resolveItemAxes(item, itemDir, {});
  const axes = resolved.axes || {};
  if (axes['颜色分类']) return { name: '颜色分类', values: axes['颜色分类'] };
  const names = Object.keys(axes);
  if (!names.length) return null;
  const pick = names.reduce((best, name) =>
    axes[name].length < axes[best].length ? name : best
  , names[0]);
  return { name: pick, values: axes[pick] };
}

function loadAssets(dir, options = {}) {
  const root = path.resolve(dir);
  const issues = [];
  const warnings = [];
  const result = { dir: root, folderName: path.basename(root), main: [], main34: [], sku: {}, detail: [], skuUnmatched: [] };

  if (!fs.existsSync(root)) {
    return { ...result, issues: ['找不到目录: ' + root], warnings };
  }

  const files = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort(naturalSort);

  if (!files.length) issues.push('目录里没有任何图片文件（支持 jpg/jpeg/png/webp）');

  const colorValues = options.colors || null;
  const matchedColors = new Set();

  for (const name of files) {
    const group = GROUPS.find((g) => name.startsWith(g.prefix));
    if (!group) {
      warnings.push('无法归类，文件名不是四类前缀之一: ' + name);
      continue;
    }
    const full = path.join(root, name);

    if (group.key === 'sku') {
      const color = name.slice(group.prefix.length).replace(/\.[^.]+$/, '');
      if (!color) {
        warnings.push('SKU 图没有颜色名: ' + name);
        continue;
      }
      // 两种命名都支持：
      //   1) SKU_软壳全包（亮面）.jpg      —— 文件名就是颜色值（优先）
      //   2) SKU_1_全包精孔软壳.jpg        —— 开头序号，对应颜色轴里的第几个
      let target = color;
      if (options.colors && options.colors.length && !options.colors.includes(color)) {
        const ordinal = Number((color.match(/^(\d+)/) || [])[1]);
        if (ordinal >= 1 && ordinal <= options.colors.length) {
          target = options.colors[ordinal - 1];
          warnings.push('SKU 图按序号对应：「' + color + '」→ 第 ' + ordinal + ' 个颜色「' + target + '」');
        }
      }
      if (result.sku[target]) warnings.push('颜色「' + target + '」有多张 SKU 图，只用第一张: ' + name);
      else result.sku[target] = full;
      matchedColors.add(target);
    } else {
      result[group.key].push(full);
    }
  }

  for (const group of GROUPS) {
    if (group.key === 'sku') continue;
    const list = result[group.key];
    if (group.required && !list.length) issues.push(group.label + ' 一张都没有（必填）');
    if (group.max && list.length > group.max) {
      const dropped = list.slice(group.max).map((f) => path.basename(f));
      warnings.push(
        group.label + ' 有 ' + list.length + ' 张，超过上限 ' + group.max +
          ' 张，只取前 ' + group.max + ' 张；未使用: ' + dropped.join('、')
      );
      result[group.key] = list.slice(0, group.max);
    }
  }

  if (colorValues && colorValues.length) {
    for (const color of colorValues) {
      if (!result.sku[color]) warnings.push('颜色「' + color + '」没有 SKU 图，页面上的颜色图会留空');
    }
    for (const color of matchedColors) {
      if (!colorValues.includes(color)) {
        result.skuUnmatched.push(color);
        issues.push(
          'SKU 图「' + color + '」在颜色轴里不存在。当前颜色轴的值是: ' + colorValues.join(' / ')
        );
      }
    }
  }

  return { ...result, issues, warnings };
}

function main() {
  const dir = getArg('dir');
  if (!dir) {
    console.error('用法: node load-listing-assets.js --dir <产品图片目录> [--item <item.json>]');
    process.exit(1);
  }

  const itemPath = getArg('item');
  let colors = null;
  let item = null;
  if (itemPath) {
    const resolvedItem = path.resolve(itemPath);
    if (!fs.existsSync(resolvedItem)) {
      console.error('找不到 ' + resolvedItem);
      process.exit(1);
    }
    item = readJson(resolvedItem);
    const axis = colorAxis(item, path.dirname(resolvedItem));
    if (axis) colors = axis.values;
  }

  const result = loadAssets(dir, { colors });

  console.log('目录: ' + result.dir);
  console.log('标题前缀（目录名）: ' + result.folderName);
  if (colors) console.log('颜色轴取值: ' + colors.join(' / '));
  console.log('');
  console.log('1:1 主图  : ' + result.main.length + ' 张');
  result.main.forEach((file) => console.log('    ' + path.basename(file)));
  console.log('3:4 主图  : ' + result.main34.length + ' 张');
  result.main34.forEach((file) => console.log('    ' + path.basename(file)));
  console.log('SKU 图    : ' + Object.keys(result.sku).length + ' 张');
  for (const [color, file] of Object.entries(result.sku)) {
    console.log('    ' + color + ' → ' + path.basename(file));
  }
  console.log('详情图    : ' + result.detail.length + ' 张');
  result.detail.forEach((file) => console.log('    ' + path.basename(file)));

  if (item && item.title) {
    const title = result.folderName + item.title;
    const length = Array.from(title).length;
    console.log('');
    console.log('标题预览（目录名 + item.json 的 title）:');
    console.log('    ' + title);
    console.log('    长度 ' + length + ' 字符' + (length > 100 ? ' ❌ 超过上限 100' : ' ✅'));
  }

  if (result.warnings.length) {
    console.log('');
    console.log('提示:');
    for (const text of result.warnings) console.log('  - ' + text);
  }
  if (result.issues.length) {
    console.log('');
    console.log('问题:');
    for (const text of result.issues) console.log('  - ' + text);
  }

  console.log('');
  console.log(result.issues.length ? '自检未通过，先修上面的问题。' : '自检通过，可以进入上架流程。');
  process.exit(result.issues.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { loadAssets, GROUPS, naturalSort };
