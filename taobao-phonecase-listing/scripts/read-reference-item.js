#!/usr/bin/env node
'use strict';

// 读一个"参考商品"页（竞品/跟款），导出结构化资料 + 全页截图。
// 在你的已登录 Chrome 里跑，所以能看到登录后才渲染的内容。
// 只读：不点任何按钮、不改任何数据、不加购物车。

const path = require('path');
const {
  connect,
  isLoginUrl,
  screenshot,
  writeJson,
  ensureDir,
  getArg,
  sleep,
  detectRiskSignals,
} = require('./lib/browser');

// 在页面上下文里执行。淘宝的类名是哈希的，所以用"语义包含"粗抓，宁可多抓不漏。
function extractReference() {
  const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();

  const pick = (selectors, limit) => {
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector)).map(textOf).filter(Boolean);
      if (nodes.length) return nodes.slice(0, limit);
    }
    return [];
  };

  const images = Array.from(document.querySelectorAll('img'))
    .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
    .filter((src) => src && /alicdn|taobao|tmall/.test(src))
    .filter((src) => !/icon|logo|avatar|loading|sprite/i.test(src));

  const skuBlocks = Array.from(document.querySelectorAll('[class*="sku" i]'))
    .map((el) => ({
      cls: String(el.className || '').slice(0, 90),
      text: textOf(el).slice(0, 500),
    }))
    .filter((block) => block.text)
    .slice(0, 40);

  const skuValues = Array.from(document.querySelectorAll('[class*="valueItem" i], [class*="ValueItem" i]'))
    .map(textOf)
    .filter((value) => value && value.length <= 40)
    .slice(0, 150);

  const propRows = Array.from(document.querySelectorAll('table tr, [class*="param" i] li, [class*="props" i] li'))
    .map((node) => Array.from(node.children).map(textOf).filter(Boolean))
    .filter((cells) => cells.length >= 2)
    .slice(0, 80);

  const bodyText = textOf(document.body);

  // 类目 ID：页面内嵌数据里通常有，能省掉一次手工探类目。
  const html = document.documentElement.innerHTML;
  const catIds = [
    ...new Set(
      [...html.matchAll(/catId["']?\s*[:=]\s*["']?(\d{3,})/g)].map((m) => m[1])
    ),
  ].slice(0, 5);
  const breadcrumbs = Array.from(document.querySelectorAll('[class*="crumb" i] a'))
    .map(textOf)
    .filter(Boolean)
    .slice(0, 10);

  // "参数信息"面板：属性是 value/label 成对渲染的，整块取出来比逐行解析稳。
  const paramsText =
    Array.from(document.querySelectorAll('[class*="param" i]'))
      .map(textOf)
      .filter((text) => text.length > 20 && text.length < 5000)
      .sort((a, b) => b.length - a.length)[0] || '';

  return {
    url: location.href,
    documentTitle: document.title,
    headings: pick(['h1', '[class*="titleText" i]', '[class*="ItemTitle" i]'], 5),
    shopName: pick(['[class*="shopName" i]', '[class*="ShopName" i]'], 3),
    priceHints: (bodyText.match(/[¥￥]\s?\d+(?:\.\d+)?/g) || []).slice(0, 20),
    imageCount: images.length,
    images: images.slice(0, 40),
    skuBlocks,
    skuValues: [...new Set(skuValues)],
    propRows,
    catIds,
    breadcrumbs,
    paramsText,
    bodyTextSample: bodyText.slice(0, 8000),
  };
}

function summarize(report) {
  const lines = [];
  lines.push('页面标题: ' + (report.page.documentTitle || '(空)'));
  lines.push('页面地址: ' + report.page.url);
  lines.push('店铺名: ' + (report.page.shopName.join(' / ') || '(没抓到)'));
  lines.push('价格线索: ' + (report.page.priceHints.join(' ') || '(没抓到)'));
  lines.push('图片: ' + report.page.imageCount + ' 张');
  lines.push('类目 ID 候选: ' + (report.page.catIds.join(', ') || '(没抓到，需在发布页探)'));
  lines.push('面包屑: ' + (report.page.breadcrumbs.join(' > ') || '(没抓到)'));
  lines.push('SKU 取值: ' + report.page.skuValues.length + ' 个');
  if (report.page.skuValues.length) {
    lines.push('  ' + report.page.skuValues.slice(0, 40).join(' / '));
  }
  if (report.page.paramsText) {
    lines.push('参数信息块: ' + report.page.paramsText.slice(0, 600));
  }
  lines.push('属性行: ' + report.page.propRows.length + ' 行');
  for (const row of report.page.propRows.slice(0, 12)) {
    lines.push('  ' + row.join('：'));
  }
  if (report.riskSignals.length) {
    lines.push('风控信号: ' + report.riskSignals.map((s) => s.id + '(' + s.matched + ')').join(', '));
  }
  return lines.join('\n');
}

async function main() {
  const id = getArg('id');
  const explicitUrl = getArg('url');
  if (!id && !explicitUrl) {
    console.error('用法: node read-reference-item.js --id <商品ID> [--out <目录>]');
    console.error('   或: node read-reference-item.js --url <完整商品页地址>');
    process.exit(1);
  }
  const url = explicitUrl || 'https://item.taobao.com/item.htm?id=' + encodeURIComponent(id);
  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const tag = id || 'reference';
  const outDir = path.join(outRoot, 'reference-' + tag);
  ensureDir(outDir);

  const { context } = await connect();
  const existing = context.pages().find((page) => page.url().includes(String(id || url.slice(0, 40))));
  const page = existing || (await context.newPage());
  if (!existing) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.bringToFront().catch(() => {});
  await sleep(6000);

  if (isLoginUrl(page.url())) {
    console.error('页面跳到登录页，请在这个浏览器窗口里登录后重跑。');
    process.exit(1);
  }

  const pageReport = await page.evaluate(extractReference);
  const riskSignals = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'reference');
  const report = {
    generatedAt: new Date().toISOString(),
    page: pageReport,
    riskSignals,
    screenshot: shot,
  };
  const jsonPath = writeJson(path.join(outDir, 'reference.json'), report);

  console.log(summarize(report));
  console.log('');
  console.log('截图: ' + shot);
  console.log('明细: ' + jsonPath);
  console.log('');
  console.log('把截图和明细一起交给 Codex，用来还原类目、属性、SKU 结构。');
  console.log('提醒：标题和详情文案要重写，直接照搬会被投诉、也会被判重复铺货。');

  // 不关浏览器：窗口留着，方便你看这一页。
  process.exit(0);
}

main().catch((err) => {
  console.error('抓取失败: ' + err.message);
  process.exit(1);
});
