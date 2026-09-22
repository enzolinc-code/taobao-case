#!/usr/bin/env node
'use strict';

// 干跑：不连浏览器、不开页面，只把商品数据算一遍。
// 输出"这个商品最终会用哪些机型、总共多少 SKU 行、编码长什么样、有没有拦截项"。
//
// 300 个链接开批量之前，先跑一遍这个，比跑到第 50 个才发现机型表写错要便宜得多。

const fs = require('fs');
const path = require('path');
const { getArg, writeJson, readJson } = require('./lib/browser');
const { preflight, findSelectors } = require('./lib/fill-core');

function walkItems(root, maxDepth = 5) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        walk(full, depth + 1);
      } else if (entry.name === 'item.json') {
        found.push(full);
      }
    }
  };
  walk(path.resolve(root), 0);
  return found.sort();
}

function checkOne(itemPath, selectorsPath) {
  const item = readJson(itemPath);
  const itemDir = path.dirname(itemPath);
  const resolvedSelectors = findSelectors(selectorsPath, itemDir);
  const selectors = resolvedSelectors ? readJson(resolvedSelectors) : {};
  const check = preflight(item, selectors, itemDir);
  const samples = check.rows.slice(0, 3).map((row) => ({
    key: row.key,
    price: row.price,
    stock: row.stock,
    outerId: row.outerId || null,
  }));

  return {
    itemPath,
    label: path.basename(itemDir),
    title: check.title || item.title || '',
    selectors: resolvedSelectors || null,
    registryPath: check.registry.path || null,
    axisValueCounts: check.skuSummary.axisValueCounts,
    skuRows: check.skuSummary.rows,
    stockTotal: check.skuSummary.stockTotal,
    blockers: check.blockers,
    warnings: check.warnings,
    samples,
  };
}

function printOne(report) {
  console.log('商品: ' + report.label);
  console.log('标题: ' + (report.title || '(空)'));
  console.log('机型表: ' + (report.registryPath || '(未使用)'));
  console.log(
    '轴值数量: ' + JSON.stringify(report.axisValueCounts) + '  →  SKU ' + report.skuRows + ' 行'
  );
  if (report.stockTotal !== null) console.log('库存合计: ' + report.stockTotal);
  if (report.samples.length) {
    console.log('前几行:');
    for (const row of report.samples) {
      console.log('  ' + row.key + '  价格 ' + row.price + '  库存 ' + row.stock + (row.outerId ? '  编码 ' + row.outerId : ''));
    }
  }
  for (const item of report.blockers) console.log('  [拦截] ' + item);
  for (const item of report.warnings) console.log('  [提示] ' + item);
  if (!report.blockers.length) console.log('  可以进入下一步（内容正确性仍需真人核对）');
}

function main() {
  const itemArg = getArg('item');
  const scanArg = getArg('scan');
  if (!itemArg && !scanArg) {
    console.error('用法: node resolve-item.js --item <商品文件夹>/item.json');
    console.error('   或: node resolve-item.js --scan <商品根目录> [--selectors <selectors.json>] [--out <目录>]');
    process.exit(1);
  }
  const selectorsPath = getArg('selectors');

  if (itemArg) {
    const target = path.resolve(itemArg);
    const itemPath = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, 'item.json')
      : target;
    if (!fs.existsSync(itemPath)) {
      console.error('找不到 ' + itemPath);
      process.exit(1);
    }
    const report = checkOne(itemPath, selectorsPath);
    printOne(report);
    process.exit(report.blockers.length ? 1 : 0);
  }

  const items = walkItems(scanArg);
  if (!items.length) {
    console.error('在 ' + path.resolve(scanArg) + ' 下没找到任何 item.json');
    process.exit(1);
  }

  const reports = items.map((itemPath) => checkOne(itemPath, selectorsPath));
  const broken = reports.filter((report) => report.blockers.length);
  const totalRows = reports.reduce((sum, report) => sum + report.skuRows, 0);
  const axesSeen = new Set();
  for (const report of reports) for (const name of Object.keys(report.axisValueCounts)) axesSeen.add(name);

  console.log('扫描到商品: ' + reports.length);
  console.log('SKU 行数合计: ' + totalRows);
  console.log('轴: ' + (axesSeen.size ? [...axesSeen].join(', ') : '(无)'));
  console.log('有拦截项的商品: ' + broken.length);
  console.log('');
  for (const report of reports) {
    const flag = report.blockers.length ? '拦截' : '通过';
    console.log(
      '  [' + flag + '] ' + report.label + '  SKU ' + report.skuRows +
        '  ' + JSON.stringify(report.axisValueCounts)
    );
  }
  if (broken.length) {
    console.log('');
    console.log('拦截明细（前 10 条）:');
    for (const report of broken.slice(0, 10)) {
      console.log('  ' + report.label + ':');
      for (const blocker of report.blockers.slice(0, 3)) console.log('    - ' + blocker);
    }
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outFile = path.join(outRoot, 'resolve-report.json');
  writeJson(outFile, {
    generatedAt: new Date().toISOString(),
    scannedRoot: path.resolve(scanArg),
    totals: { items: reports.length, skuRows: totalRows, blockedItems: broken.length },
    reports,
  });
  console.log('');
  console.log('明细: ' + outFile);
  process.exit(broken.length ? 1 : 0);
}

main();
