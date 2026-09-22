#!/usr/bin/env node
'use strict';

// 在下拉里搜索指定关键词，确认平台到底有没有这个取值。
// 属性下拉是虚拟滚动列表，直接读只能看到前十几项，必须靠搜索框筛。
//
// 用法: node search-attribute-options.js --pairs "sell-field-p-20021=菲林;sell-field-p-557317827=转印"
// 只搜索和读取，不选中任何选项。

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
  '.options-item, .next-menu-item:not(.next-nav-item), li[role="option"], [role="option"]';

async function search(page, fieldId, query) {
  const container = page.locator('#' + fieldId).first();
  if (!(await container.count())) return { fieldId, query, error: '找不到属性行' };

  const trigger = container.locator('.next-select-trigger, [role="combobox"], .next-select').first();
  if (!(await trigger.count())) return { fieldId, query, error: '不是下拉控件' };

  try {
    await trigger.click();
    await sleep(1000);
    const searchBox = page.locator('.options-search input').first();
    const hasSearch = await searchBox.count();
    if (hasSearch) {
      await searchBox.fill(query);
      await sleep(1200);
    }
    const texts = await page.locator(OPTION_SELECTOR).allInnerTexts().catch(() => []);
    const cleaned = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    return { fieldId, query, hasSearchBox: Boolean(hasSearch), matches: cleaned };
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => {});
    return { fieldId, query, error: String(err.message || err).split('\n')[0] };
  }
}

async function main() {
  const pairs = getArg('pairs');
  if (!pairs) {
    console.error('用法: node search-attribute-options.js --pairs "sell-field-p-20021=菲林;sell-field-p-557317827=转印"');
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'attr-search-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布宝贝页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  const results = [];
  for (const pair of pairs.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [fieldId, query] = pair.split('=');
    const result = await search(page, fieldId.trim(), (query || '').trim());
    results.push(result);
    console.log(
      '[' + fieldId + '] 搜索「' + query + '」→ ' +
        (result.error ? result.error : (result.matches.length ? result.matches.join(' / ') : '没有匹配项'))
    );
    await sleep(700);
  }

  const riskSignals = await detectRiskSignals(page);
  const file = writeJson(path.join(outDir, 'attribute-search.json'), {
    generatedAt: new Date().toISOString(),
    results,
    riskSignals,
  });
  console.log('');
  console.log('明细: ' + file);
  process.exit(0);
}

main().catch((err) => {
  console.error('搜索失败: ' + err.message);
  process.exit(1);
});
