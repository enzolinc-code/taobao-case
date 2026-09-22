#!/usr/bin/env node
'use strict';

// 把生成的 SKU Excel 导入发布页的「批量导入」对话框，然后报告页面怎么说。
// 只做导入和读取结果，不点提交、不点保存草稿。

const fs = require('fs');
const path = require('path');
const {
  connect,
  sleep,
  screenshot,
  writeJson,
  ensureDir,
  getArg,
  detectRiskSignals,
  readErrorMarkers,
} = require('./lib/browser');

async function main() {
  const file = getArg('file');
  if (!file) {
    console.error('用法: node import-sku-excel.js --file <生成的SKU表.xlsx> [--out <目录>]');
    process.exit(1);
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error('找不到文件: ' + filePath);
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'import-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布宝贝页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  const openButton = page.locator('button').filter({ hasText: /批量导入/ }).first();
  if (!(await openButton.count())) {
    console.error('页面上没有「批量导入」按钮，先用 dump-field-map.js 看看 SKU 区结构。');
    process.exit(1);
  }

  await openButton.click();
  await sleep(2500);

  const input = page.locator('input[type=file][accept*="xls"]').first();
  if (!(await input.count())) {
    console.error('对话框里没找到接受 xls 的文件输入框');
    process.exit(1);
  }

  await input.setInputFiles(filePath);
  console.log('已投递文件，等待平台解析…');
  await sleep(9000);

  const dialogText = await page
    .evaluate(() => {
      const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
      const dialog = document.querySelector('.next-dialog, [role="dialog"]');
      return dialog ? textOf(dialog).slice(0, 3000) : '';
    })
    .catch(() => '');

  const errorMarkers = await readErrorMarkers(page);
  const riskSignals = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after-import');

  const report = {
    generatedAt: new Date().toISOString(),
    file: filePath,
    dialogText,
    errorMarkers,
    riskSignals,
    screenshot: shot,
  };
  const reportPath = writeJson(path.join(outDir, 'import-report.json'), report);

  console.log('');
  console.log('对话框反馈: ' + (dialogText || '(对话框已关闭，可能是导入成功)'));
  if (errorMarkers.length) {
    console.log('页面错误标记:');
    for (const marker of errorMarkers) console.log('  - ' + marker);
  }
  if (riskSignals.length) {
    console.log('风控信号: ' + riskSignals.map((s) => s.id).join(', '));
  }
  console.log('');
  console.log('截图: ' + shot);
  console.log('报告: ' + reportPath);
  console.log('=== 没有提交任何内容。核对页面 SKU 表后再决定下一步。 ===');

  process.exit(0);
}

main().catch((err) => {
  console.error('导入失败: ' + err.message);
  process.exit(1);
});
