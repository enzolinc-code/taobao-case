#!/usr/bin/env node
'use strict';

// 校准工具：打开发布宝贝页，导出所有可见控件的标签与选择器，并截图。
// 每个类目首次上架前跑一次；页面改版后重跑。

const path = require('path');
const {
  connect,
  openPublishPage,
  publishUrl,
  isLoginUrl,
  screenshot,
  writeJson,
  ensureDir,
  getArg,
  sleep,
} = require('./lib/browser');

// 这段在页面上下文里执行，用于生成选择器和猜测控件标签。
function extractPage() {
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 2 &&
      rect.height > 2
    );
  };

  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      let part = node.tagName.toLowerCase();
      const classes = (node.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^[0-9]/.test(c))
        .slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id) {
        parts[0] = '#' + node.id;
        break;
      }
      node = parent;
    }
    return parts.join(' > ');
  };

  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    if (el.id && window.CSS && window.CSS.escape) {
      const labelled = document.querySelector('label[for="' + window.CSS.escape(el.id) + '"]');
      if (labelled && labelled.textContent.trim()) return labelled.textContent.trim();
    }
    let node = el;
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 80) return text;
    }
    return (el.getAttribute('placeholder') || '').trim();
  };

  const query =
    'input, select, textarea, [contenteditable="true"], [role="combobox"], [role="radio"], [role="checkbox"], button';
  const items = [];
  for (const el of Array.from(document.querySelectorAll(query))) {
    if (!isVisible(el)) continue;
    items.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      currentValue: String(el.value || '').slice(0, 40),
      disabled: el.disabled === true,
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      label: labelOf(el),
      selector: cssPath(el),
    });
  }

  const errorMarkers = Array.from(document.querySelectorAll('body *'))
    .filter((el) => /错误\s*[(（]\s*\d+\s*[)）]/.test(el.textContent || ''))
    .slice(0, 5)
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200));

  // SKU 区单独导一遍：手机壳的核心工作量在这里，属性区的控件清单看不出表格结构。
  const skuArea = {
    axisContainers: Array.from(document.querySelectorAll('[id^="struct-p-"]')).map((el) => ({
      id: el.id,
      label: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      inputs: Array.from(el.querySelectorAll('input'))
        .slice(0, 6)
        .map((input) => ({
          placeholder: input.getAttribute('placeholder') || '',
          selector: cssPath(input),
        })),
      values: Array.from(el.querySelectorAll('[class*="tag"], [class*="value"]'))
        .map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((text) => text && text.length <= 30)
        .slice(0, 20),
    })),
    tables: Array.from(document.querySelectorAll('table')).slice(0, 3).map((table) => ({
      rowCount: table.querySelectorAll('tbody tr').length,
      headers: Array.from(table.querySelectorAll('thead th'))
        .map((th) => (th.innerText || '').replace(/\s+/g, ' ').trim())
        .slice(0, 12),
      firstRowCells: Array.from(table.querySelectorAll('tbody tr:first-child td'))
        .slice(0, 12)
        .map((cell) => ({
          text: (cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          inputs: Array.from(cell.querySelectorAll('input')).map((input) => ({
            placeholder: input.getAttribute('placeholder') || '',
            selector: cssPath(input),
          })),
        })),
    })),
  };

  return {
    url: location.href,
    title: document.title,
    itemCount: items.length,
    items,
    errorMarkers,
    skuArea,
  };
}

function summarize(report) {
  const lines = [];
  lines.push('页面标题: ' + report.page.title);
  lines.push('页面地址: ' + report.page.url);
  lines.push('可见控件: ' + report.page.itemCount);
  lines.push('iframe: ' + (report.frames.length ? '' : '无'));
  for (const frame of report.frames) {
    lines.push('  - ' + frame.url);
  }
  if (report.page.errorMarkers.length) {
    lines.push('页面错误标记:');
    for (const marker of report.page.errorMarkers) lines.push('  - ' + marker);
  }
  lines.push('');
  lines.push('控件清单（前 60 个）:');
  for (const item of report.page.items.slice(0, 60)) {
    lines.push(
      '  [' +
        item.tag +
        (item.type ? ':' + item.type : '') +
        '] ' +
        (item.label || '(无标签)') +
        (item.required ? ' *必填' : '') +
        '\n      选择器: ' +
        item.selector
    );
  }
  const skuArea = report.page.skuArea || { axisContainers: [], tables: [] };
  lines.push('');
  lines.push(
    'SKU 区: 销售属性容器 ' + skuArea.axisContainers.length + ' 个，表格 ' + skuArea.tables.length + ' 个'
  );
  for (const axis of skuArea.axisContainers) {
    lines.push('  - ' + axis.id + ' :: ' + (axis.label || '(无文案)'));
  }
  for (const table of skuArea.tables) {
    lines.push(
      '  - 表格: ' + table.rowCount + ' 行，列头 [' + table.headers.join(' | ') + ']'
    );
  }
  return lines.join('\n');
}

async function main() {
  const catId = getArg('cat-id') || getArg('catId');
  const explicitUrl = getArg('url');
  const outRoot = getArg('out') || path.join(process.cwd(), '_listing-work');

  if (!catId && !explicitUrl) {
    console.error('用法: node probe-publish-page.js --cat-id <类目ID> [--out <目录>]');
    console.error('也可以用 --url <完整发布页地址> 覆盖默认的类目直连地址。');
    process.exit(1);
  }

  const url = explicitUrl || publishUrl(catId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(outRoot, 'probe-' + stamp);
  ensureDir(outDir);

  const { context } = await connect();
  const page = await openPublishPage(context, url);

  // 发布页是前端渲染的，给页面留出时间。
  await sleep(4000);

  if (isLoginUrl(page.url())) {
    console.error('页面跳转到登录页: ' + page.url());
    console.error('请真人在该浏览器窗口里扫码登录，然后重跑本脚本。');
    process.exit(1);
  }

  const pageReport = await page.evaluate(extractPage);
  const frames = page
    .frames()
    .filter((f) => f !== page.mainFrame())
    .map((f) => ({ url: f.url(), name: f.name() }));

  const report = { generatedAt: new Date().toISOString(), catId: catId || null, page: pageReport, frames };
  const shot = await screenshot(page, outDir, 'publish-page');
  const jsonPath = writeJson(path.join(outDir, 'probe.json'), report);

  console.log(summarize(report));
  console.log('');
  console.log('截图: ' + shot);
  console.log('控件明细: ' + jsonPath);
  console.log('');
  console.log('下一步: 按上面的标签和选择器编写 selectors.json（可参考 assets/selectors.template.json）。');
  console.log('填不准的字段先留空，交给真人；不要凭猜测写选择器。');

  process.exit(0);
}

main().catch((err) => {
  console.error('校准失败: ' + err.message);
  process.exit(1);
});
