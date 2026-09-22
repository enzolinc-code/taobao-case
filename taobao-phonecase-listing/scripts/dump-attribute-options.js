#!/usr/bin/env node
'use strict';

// 逐个打开属性下拉，把可选值导出来。
// 属性值必须用平台原词，猜的写法会在提交时报错或落成另一个值。
//
// 只打开下拉读选项，然后按 Esc 关掉——不选中任何选项、不填任何值。

const path = require('path');
const {
  connect,
  sleep,
  writeJson,
  ensureDir,
  getArg,
  detectRiskSignals,
} = require('./lib/browser');

const OPTION_SELECTOR =
  '.next-menu-item:not(.next-nav-item), .options-item, li[role="option"], [role="option"]';

async function readOptions(page, containerId) {
  const container = page.locator('#' + containerId).first();
  if (!(await container.count())) return { id: containerId, error: '找不到该属性行' };

  const trigger = container
    .locator('.next-select-trigger, [role="combobox"], .next-select')
    .first();
  if (!(await trigger.count())) return { id: containerId, error: '这一行不是下拉控件' };

  const label = await container
    .evaluate((el) => {
      const node = el.querySelector('.sell-component-info-wrapper-label span[title], .sell-component-info-wrapper-label span');
      return node ? (node.getAttribute('title') || node.textContent || '').trim().slice(0, 30) : '';
    })
    .catch(() => '');

  try {
    await trigger.click();
    await sleep(1200);
    const values = await page
      .locator(OPTION_SELECTOR)
      .allInnerTexts()
      .catch(() => []);
    const cleaned = [...new Set(values.map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    return { id: containerId, label, count: cleaned.length, options: cleaned.slice(0, 120) };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => {});
    return { id: containerId, label, error: String(err.message || err).split('\n')[0] };
  }
}

async function main() {
  const idsArg = getArg('fields');
  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'attr-options-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布宝贝页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  const ids = idsArg
    ? idsArg.split(',').map((s) => s.trim()).filter(Boolean)
    : await page.evaluate(() =>
        Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((el) => el.id)
      );

  const results = [];
  for (const id of ids) {
    const result = await readOptions(page, id);
    results.push(result);
    console.log(
      '[' + id + '] ' + (result.label || '') + ' → ' +
        (result.error ? '读取失败: ' + result.error : result.count + ' 个可选项')
    );
    if (result.options) {
      console.log('   ' + result.options.slice(0, 40).join(' / '));
    }
    await sleep(600);
  }

  const riskSignals = await detectRiskSignals(page);
  const file = writeJson(path.join(outDir, 'attribute-options.json'), {
    generatedAt: new Date().toISOString(),
    url: page.url(),
    attributes: results,
    riskSignals,
  });
  console.log('');
  console.log('明细: ' + file);
  if (riskSignals.length) console.log('风控信号: ' + riskSignals.map((s) => s.id).join(', '));
  process.exit(0);
}

main().catch((err) => {
  console.error('导出失败: ' + err.message);
  process.exit(1);
});
