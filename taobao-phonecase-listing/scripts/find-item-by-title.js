#!/usr/bin/env node
'use strict';

// 按标题（片段）在卖家后台搜商品，输出找到的商品 ID。
// 用途：**发布流程报"未成功"时，先用它确认到底发出去没有**，再决定要不要重跑。
//       （2026-09-29 踩过：639 报失败其实已提交，直接重跑就多出一条重复链接。）
//
// 用法: node find-item-by-title.js "部分标题"
// 退出码: 0 = 找到（stdout 第一行是 ID）；1 = 没找到；2 = 出错

const path = require('path');
const { connect, sleep } = require('./lib/browser');

const KEYWORD = process.argv[2];

async function main() {
  if (!KEYWORD) {
    console.error('用法: node find-item-by-title.js "部分标题"');
    process.exit(2);
  }
  const { context } = await connect();
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('https://myseller.taobao.com/home.htm/SellManage/on_sale?current=1&pageSize=100', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await sleep(11000);

    // 「商品标题」输入框（默认那个是"商品ID"）——必须用真键盘输入，直接赋值 React 不认
    const box = await page.evaluateHandle(() => {
      const items = Array.from(document.querySelectorAll('.next-formily-item, .next-form-item'));
      const item = items.find((el) => (el.innerText || '').trim().startsWith('商品标题'));
      return item ? item.querySelector('input') : null;
    });
    const el = box.asElement();
    if (!el) {
      console.error('没找到「商品标题」输入框');
      process.exit(2);
    }
    await el.click().catch(() => {});
    await page.keyboard.type(KEYWORD, { delay: 50 });
    const btn = page.locator('button:has-text("搜索"), .next-btn:has-text("搜索")').first();
    if (await btn.count()) await btn.click().catch(() => {});
    else await page.keyboard.press('Enter').catch(() => {});
    await sleep(9000);

    const found = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      const ids = Array.from(new Set((txt.match(/ID:(\d{9,})/g) || []).map((s) => s.replace(/[^\d]/g, ''))));
      return { count: ids.length, ids };
    });
    if (found.count > 0) {
      console.log(found.ids[0]);
      if (found.count > 1) console.log('⚠️ 找到 ' + found.count + ' 条同标题商品：' + found.ids.join('、'));
      process.exit(0);
    }
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(2);
});
