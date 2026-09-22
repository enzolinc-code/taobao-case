#!/usr/bin/env node
'use strict';

// 导出当前类目的"字段地图"：每个属性行的 id、名称、必填、控件类型，以及 SKU 区块有什么入口。
// 发布页改版后重跑这个，比对着 probe 的控件清单猜要快。
//
// --open-import 会点开"批量导入"对话框并截图（只看不上传，结束按 Esc 关闭）。

const path = require('path');
const {
  connect,
  screenshot,
  writeJson,
  ensureDir,
  getArg,
  sleep,
  detectRiskSignals,
} = require('./lib/browser');

const COLLECT = () => {
  const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();

  const rows = Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map((el) => {
    const labelEl = el.querySelector(
      '.sell-component-info-wrapper-label span[title], .sell-component-info-wrapper-label span'
    );
    const label =
      (labelEl && (labelEl.getAttribute('title') || textOf(labelEl))) || textOf(el).slice(0, 40);
    const control = el.querySelector('select')
      ? 'select'
      : el.querySelector('input[type=radio]')
        ? 'radio'
        : el.querySelector('input[type=checkbox]')
          ? 'checkbox'
          : el.querySelector('input')
            ? 'input'
            : el.querySelector('button')
              ? 'button'
              : 'unknown';
    return {
      id: el.id,
      label,
      control,
      required: /\*/.test(textOf(el).slice(0, 160)),
      sample: textOf(el).slice(0, 160),
    };
  });

  const titleInputs = Array.from(
    document.querySelectorAll('.sell-component-tbtitle-input input')
  ).map((input) => ({
    placeholder: input.getAttribute('placeholder') || '',
    maxLength: input.getAttribute('maxlength') || null,
  }));

  const buttons = Array.from(document.querySelectorAll('button')).map(textOf).filter(Boolean);
  const skuArea = {
    hasCreateSpec: buttons.some((text) => /创建规格/.test(text)),
    hasBatchImport: buttons.some((text) => /批量导入/.test(text)),
    axisContainers: Array.from(document.querySelectorAll('[id^="struct-p-"]')).map((el) => ({
      id: el.id,
      text: textOf(el).slice(0, 60),
    })),
  };

  const submitButtons = Array.from(document.querySelectorAll('button'))
    .map(textOf)
    .filter((text) => /提交|保存草稿/.test(text));

  return { rows, titleInputs, skuArea, submitButtons };
};

async function main() {
  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(outRoot, 'field-map-' + stamp);
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('当前没有打开发布宝贝页。先用 probe-publish-page.js --cat-id <类目ID> 打开。');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  const map = await page.evaluate(COLLECT);

  console.log('类目: ' + (await page.title()));
  console.log('标题输入框: ' + JSON.stringify(map.titleInputs));
  console.log('属性行: ' + map.rows.length + ' 个');
  for (const row of map.rows) {
    console.log(
      '  [' + row.control + ']' + (row.required ? '*' : ' ') + ' ' + row.label + '  (' + row.id + ')'
    );
  }
  console.log('SKU 区: 创建规格=' + map.skuArea.hasCreateSpec + '  批量导入=' + map.skuArea.hasBatchImport);
  console.log('  struct-p-* 容器 ' + map.skuArea.axisContainers.length + ' 个');
  console.log('提交/草稿按钮: ' + map.submitButtons.join(' | '));

  let importDialog = null;
  if (process.argv.includes('--open-import')) {
    const button = page.locator('button').filter({ hasText: /批量导入/ }).first();
    if (await button.count()) {
      await button.click();
      await sleep(2500);
      const shot = await screenshot(page, outDir, 'batch-import-dialog');
      importDialog = await page.evaluate(() => {
        const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
        const dialog = document.querySelector(
          '[class*="dialog" i], [class*="Dialog" i], [role="dialog"]'
        );
        return {
          text: dialog ? textOf(dialog).slice(0, 2000) : '',
          inputs: Array.from(document.querySelectorAll('input[type=file]')).map((i) => i.outerHTML.slice(0, 200)),
        };
      });
      console.log('');
      console.log('批量导入对话框:');
      console.log('  ' + (importDialog.text || '(没抓到对话框文本)'));
      console.log('  截图: ' + shot);
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      console.log('没找到「批量导入」按钮');
    }
  }

  const riskSignals = await detectRiskSignals(page);
  const file = writeJson(path.join(outDir, 'field-map.json'), {
    generatedAt: new Date().toISOString(),
    url: page.url(),
    map,
    importDialog,
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
