#!/usr/bin/env node
'use strict';

// 单件：按 selectors.json 把发布页填到"只差点提交"。
// 这个脚本永远不会点击提交按钮，也不点保存草稿。

const { getArg } = require('./lib/browser');
const { runFill } = require('./lib/fill-core');

async function main() {
  const item = getArg('item');
  if (!item) {
    console.error('用法: node fill-listing.js --item <商品文件夹>/item.json [--selectors <selectors.json>] [--force]');
    process.exit(1);
  }

  const result = await runFill({
    itemPath: item,
    selectorsPath: getArg('selectors'),
    outRoot: getArg('out'),
    options: { force: process.argv.includes('--force'), catId: getArg('cat-id') },
  });

  console.log('状态: ' + result.status + (result.reason ? ' — ' + result.reason : ''));
  console.log('类目: ' + (result.catId || '(未填)'));
  console.log('SKU: ' + JSON.stringify(result.skuSummary));

  for (const blocker of result.preflight.blockers) console.log('  [预检拦截] ' + blocker);
  for (const warning of result.preflight.warnings) console.log('  [预检提示] ' + warning);
  if (result.hint) console.log('  ' + result.hint);

  const ok = result.report.filter((r) => r.status === 'ok');
  const failed = result.report.filter((r) => r.status === 'failed');
  console.log('已填写: ' + ok.length + ' 项');
  for (const entry of ok) console.log('  [OK]   ' + entry.key + (entry.detail ? ' — ' + entry.detail : ''));
  if (failed.length) {
    console.log('失败: ' + failed.length + ' 项');
    for (const entry of failed) console.log('  [失败] ' + entry.key + ' — ' + entry.detail);
  }
  if (result.errorMarkers.length) {
    console.log('页面错误标记:');
    for (const marker of result.errorMarkers) console.log('  - ' + marker);
  }
  if (result.riskSignals.length) {
    console.log('风控信号:');
    for (const signal of result.riskSignals) console.log('  - ' + signal.id + ': ' + signal.matched);
  }

  console.log('');
  if (result.screenshot) console.log('截图: ' + result.screenshot);
  console.log('报告目录: ' + result.outDir);
  console.log('=== 未提交任何内容。核对页面后由真人点提交。 ===');

  process.exit(result.status === 'blocked' ? 2 : failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('填写失败: ' + err.message);
  process.exit(1);
});
