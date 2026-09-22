'use strict';

// 上架流水线：预检 → 打开发布页 → 按 selectors.json 填 → 读回错误与风控信号 → 落报告。
// 这个模块不决定要不要提交；提交由调用方通过 options.submit 显式开启。

const fs = require('fs');
const path = require('path');
const {
  connect,
  openPublishPage,
  publishUrl,
  isLoginUrl,
  resolveFrame,
  realType,
  nativeSetValue,
  chooseOption,
  uploadFiles,
  uploadViaChooser,
  screenshot,
  writeJson,
  readJson,
  ensureDir,
  getPath,
  pace,
  sleep,
  detectRiskSignals,
  readErrorMarkers,
} = require('./browser');
const skuMatrix = require('./sku-matrix');
const titleGuard = require('./title-guard');
const modelRegistry = require('./model-registry');

const STRATEGY_ALIASES = {
  type: 'type',
  native: 'native',
  select: 'choose',
  click: 'choose',
  choose: 'choose',
  upload: 'upload',
  filechooser: 'filechooser',
  skuTable: 'skuTable',
  manual: 'manual',
};

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSelectors(explicit, itemDir) {
  const candidates = [
    explicit,
    path.join(process.cwd(), 'selectors.json'),
    itemDir ? path.join(itemDir, 'selectors.json') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 预检只做两类判断：标题的品牌词写法、SKU 矩阵的完整性。
// 这两类错误一旦批量提交，代价是批量下架扣分，所以默认拦下来。
// 标题 = 图片目录名 + titleSuffix（产品图片目录名就是标题前缀）。
function effectiveTitle(item, itemDir) {
  if (!item.titleSuffix) return item.title || '';
  const base = item.assetsDir
    ? path.basename(path.resolve(itemDir || process.cwd(), item.assetsDir))
    : path.basename(itemDir || process.cwd());
  return base + item.titleSuffix;
}

function preflight(item, selectors, itemDir) {
  const limits = selectors.limits || {};
  const title = effectiveTitle(item, itemDir);
  const titleCheck = titleGuard.checkTitle(title, {
    maxChars: Number(limits.titleChars || selectors.titleMaxChars || 60),
  });

  // axes 里可以直接写数组，也可以引用全店共用的机型清单。
  const registry = modelRegistry.resolveItemAxes(item, itemDir, {
    defaultRegistry: selectors.modelList,
  });
  const normalized = { ...item, axes: registry.axes };
  const expanded = modelRegistry.applyOuterIds(skuMatrix.expand(normalized), item, registry.entriesByAxis);
  const rows = expanded.rows;
  const skuCheck = skuMatrix.validate(rows, {
    maxRows: limits.maxSkuRows || selectors.maxSkuRows,
  });

  const blockers = [];
  const warnings = [];
  // 标题合规检查的处置方式由 item.titleGuardMode 决定。
  // 默认 block（拦截）；店铺明确要求原样使用标题时改为 warn，只提示不阻断。
  const guardMode = item.titleGuardMode || 'block';
  if (guardMode === 'block') {
    blockers.push(...titleCheck.issues.map((text) => '标题：' + text));
  } else if (guardMode === 'warn') {
    warnings.push(...titleCheck.issues.map((text) => '标题（已放行，风险由店铺自行承担）：' + text));
  }
  blockers.push(...skuCheck.issues.map((text) => 'SKU：' + text));
  blockers.push(...registry.issues.map((text) => '机型清单：' + text));
  warnings.push(...titleCheck.warnings.map((text) => '标题：' + text));
  warnings.push(...skuCheck.warnings.map((text) => 'SKU：' + text));
  warnings.push(...registry.warnings.map((text) => '机型清单：' + text));
  warnings.push(...expanded.warnings.map((text) => '编码：' + text));

  return {
    blockers,
    warnings,
    title,
    titleCheck,
    skuCheck,
    registry,
    rows,
    skuSummary: skuMatrix.summarize(rows),
  };
}

async function elementAt(ctx, selector, index = 0, timeout = 15000) {
  const el = ctx.locator(selector).nth(Number(index) || 0);
  await el.waitFor({ state: 'visible', timeout });
  return el;
}

// Locator.type() 在新版 Playwright 里已移除，优先用 pressSequentially。
async function typeInto(locator, value, delay = 30) {
  const text = String(value);
  if (typeof locator.pressSequentially === 'function') {
    await locator.pressSequentially(text, { delay });
  } else {
    await locator.type(text, { delay });
  }
}

// 轴值有两种存在形式：可从下拉里选，或需要手工新增（机型这种长尾值多半是后者）。
async function ensureAxisValue(ctx, axisCfg, value) {
  const strategy = axisCfg.strategy || 'choose';
  const index = Number(axisCfg.index || 0);

  if (strategy === 'native') {
    await nativeSetValue(ctx, axisCfg.selector, value, index);
    return '已填入(native)';
  }
  if (strategy === 'type') {
    await realType(ctx, axisCfg.selector, value, index);
    return '已填入(键盘输入)';
  }
  if (strategy === 'addValue') {
    const input = await elementAt(ctx, axisCfg.addSelector || axisCfg.selector, Number(axisCfg.addIndex || 0));
    await input.click();
    await input.press('Control+A').catch(() => {});
    await input.press('Backspace').catch(() => {});
    await typeInto(input, value);
    await input.press('Enter').catch(() => {});
    await sleep(400);
    return '已新增(回车提交)';
  }
  const matched = await chooseOption(ctx, axisCfg.selector, value, index);
  return '已选中' + (matched ? '「' + matched + '」' : '');
}

// 表格行不按列序号定位，按行文本里是否包含全部轴值来认行——
// 列顺序随平台改版变，轴值文本不会。
async function fillSkuRow(page, skuCfg, row) {
  const table = skuCfg.table || {};
  if (!table.rowSelector || !table.cells) {
    return { ok: false, reason: 'selectors.json 的 sku.table 缺少 rowSelector 或 cells' };
  }
  const rowsLoc = page.locator(table.rowSelector);
  const count = await rowsLoc.count();
  const wanted = Object.values(row.axes).map((v) => String(v));

  for (let i = 0; i < count; i++) {
    const rowLoc = rowsLoc.nth(i);
    const text = ((await rowLoc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    if (!wanted.every((value) => text.includes(value))) continue;

    const filled = [];
    for (const [field, cfg] of Object.entries(table.cells)) {
      const value = row[field];
      if (value === undefined || value === null || value === '') continue;
      const cell = rowLoc.locator(cfg.selector).nth(Number(cfg.index || 0));
      if (!(await cell.count())) return { ok: false, reason: '行内找不到 ' + field + ' 的输入框' };
      if ((cfg.strategy || 'type') === 'native') {
        await cell.evaluate((node, v) => {
          const proto = node instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(node, v);
          else node.value = v;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.dispatchEvent(new Event('blur', { bubbles: true }));
        }, String(value));
      } else {
        await cell.click();
        await cell.press('Control+A').catch(() => {});
        await cell.press('Backspace').catch(() => {});
        await typeInto(cell, value, 25);
        await cell.press('Tab').catch(() => {});
      }
      filled.push(field);
      await pace();
    }
    return { ok: true, detail: '已填 ' + filled.join('/') };
  }
  return { ok: false, reason: '表格里找不到轴值匹配的行（' + row.key + '）' };
}

async function fillSkuTable({ page, selectors, rows }) {
  const skuCfg = selectors.sku;
  if (!skuCfg) {
    return {
      status: 'failed',
      detail: 'selectors.json 没有 sku 配置段。SKU 表必须先校准，见 references/sku-table.md',
    };
  }
  const details = [];
  const failed = [];

  for (const [axisName, axisCfg] of Object.entries(skuCfg.axes || {})) {
    const values = [...new Set(rows.map((row) => row.axes[axisName]).filter(Boolean))];
    for (const value of values) {
      try {
        const ctx = await resolveFrame(page, axisCfg.frameUrl);
        const result = await ensureAxisValue(ctx, axisCfg, value);
        details.push('轴 ' + axisName + '「' + value + '」' + result);
      } catch (err) {
        failed.push('轴 ' + axisName + '「' + value + '」：' + String(err.message || err).split('\n')[0]);
      }
      await pace();
    }
  }

  for (const row of rows) {
    try {
      const filled = await fillSkuRow(page, skuCfg, row);
      if (filled.ok) details.push(row.key + ' ' + (filled.detail || '已填'));
      else failed.push(row.key + '：' + filled.reason);
    } catch (err) {
      failed.push(row.key + '：' + String(err.message || err).split('\n')[0]);
    }
    await pace();
  }

  return {
    status: failed.length ? 'failed' : 'ok',
    detail: '成功 ' + (rows.length - failed.length) + '/' + rows.length + ' 行',
    samples: details.slice(0, 8),
    failures: failed.slice(0, 10),
    failureCount: failed.length,
  };
}

async function applyRule({ rule, item, itemDir, page, report, rows, selectors }) {
  const strategy = STRATEGY_ALIASES[rule.strategy || 'type'];
  const key = rule.key;
  const entry = { key, strategy: rule.strategy || 'type', status: 'skipped', detail: '' };

  if (!key) {
    entry.status = 'failed';
    entry.detail = '规则缺少 key';
    report.push(entry);
    return;
  }
  if (strategy === 'manual') {
    entry.detail = rule.note || '标记为人工填写';
    report.push(entry);
    return;
  }

  try {
    if (strategy === 'skuTable') {
      const result = await fillSkuTable({ page, selectors, rows });
      Object.assign(entry, result);
      report.push(entry);
      return;
    }

    const value = rule.value !== undefined ? rule.value : getPath(item, key);
    if (value === undefined || value === null || value === '') {
      entry.detail = 'item.json 中没有对应值';
      report.push(entry);
      return;
    }
    if (!rule.selector) {
      entry.status = 'failed';
      entry.detail = '规则缺少 selector';
      report.push(entry);
      return;
    }

    const ctx = await resolveFrame(page, rule.frameUrl);
    const index = Number(rule.index || 0);

    if (strategy === 'upload' || strategy === 'filechooser') {
      const raw = Array.isArray(value) ? value : [value];
      const files = raw
        .map((p) => (path.isAbsolute(p) ? p : path.resolve(itemDir, p)))
        .filter((p) => fs.existsSync(p));
      if (!files.length) throw new Error('图片文件都不存在: ' + raw.join(', '));
      if (strategy === 'filechooser') await uploadViaChooser(ctx, rule.selector, files, index);
      else await uploadFiles(ctx, rule.selector, files, index);
      entry.status = 'ok';
      entry.detail = '已上传 ' + files.length + ' 个文件' + (raw.length - files.length ? '，缺少 ' + (raw.length - files.length) + ' 个' : '');
    } else if (strategy === 'native') {
      await nativeSetValue(ctx, rule.selector, value, index);
      entry.status = 'ok';
    } else if (strategy === 'choose') {
      const matched = await chooseOption(ctx, rule.selector, value, index);
      entry.status = 'ok';
      if (matched && matched !== String(value)) entry.detail = '按相近选项匹配为 "' + matched + '"';
    } else {
      await realType(ctx, rule.selector, value, index);
      entry.status = 'ok';
    }
  } catch (err) {
    entry.status = 'failed';
    entry.detail = String(err.message || err).split('\n')[0];
  }

  report.push(entry);
  await pace();
}

// 只匹配提交按钮的精确文案；"保存草稿"永远不会被这个函数点到。
async function submitItem(page, selectors) {
  const text = selectors.submitText || '提交宝贝信息';
  const button = page
    .locator('button, a, div[role="button"], span[role="button"]')
    .filter({ hasText: new RegExp('^\\s*' + escapeRegExp(text) + '\\s*$') })
    .first();

  if (!(await button.count())) return { attempted: true, ok: false, reason: '找不到提交按钮：' + text };

  const handle = await button.elementHandle();
  if (!handle) return { attempted: true, ok: false, reason: '提交按钮拿不到句柄' };
  // 按钮可能在视口外，Playwright 的可见性检查会超时；页面本身能响应 DOM 点击。
  await handle.evaluate((node) => node.click());

  await sleep(6000);
  const text2 = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  const success = /发布成功|宝贝发布成功|已发布|创建成功/.test(text2);
  const failure = String(text2).match(/发布失败[^\n]{0,80}|提交失败[^\n]{0,80}|请修改[^\n]{0,80}/);
  return {
    attempted: true,
    ok: success && !failure,
    evidence: success ? '页面出现发布成功提示' : failure ? failure[0] : '没有看到明确的成功或失败提示',
  };
}

async function runFill({ itemPath, selectorsPath, outRoot, options = {} }) {
  const resolvedItem = path.resolve(itemPath);
  if (!fs.existsSync(resolvedItem)) throw new Error('找不到商品资料文件: ' + resolvedItem);
  const itemDir = path.dirname(resolvedItem);
  const item = readJson(resolvedItem);

  const resolvedSelectors = findSelectors(selectorsPath, itemDir);
  if (!resolvedSelectors) throw new Error('找不到 selectors.json。先用 probe-publish-page.js 校准。');
  const selectors = readJson(resolvedSelectors);
  const rules = Array.isArray(selectors.rules) ? selectors.rules : [];
  if (!rules.length) throw new Error('selectors.json 里没有 rules。');

  const slug = path.basename(itemDir).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'item';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(outRoot || path.join(process.cwd(), '_listing-work'), 'fill-' + slug + '-' + stamp);
  ensureDir(outDir);

  const check = preflight(item, selectors, itemDir);
  const catId = options.catId || item.catId || selectors.catId;
  const result = {
    generatedAt: new Date().toISOString(),
    item: resolvedItem,
    selectors: resolvedSelectors,
    catId: catId || null,
    title: check.title || item.title || '',
    skuSummary: check.skuSummary,
    registry: {
      path: check.registry.path || null,
      skipped: Boolean(check.registry.skippedRegistry),
      axisValueCounts: check.skuSummary.axisValueCounts,
    },
    preflight: { blockers: check.blockers, warnings: check.warnings },
    report: [],
    errorMarkers: [],
    riskSignals: [],
    submitted: false,
    submit: null,
    screenshot: null,
    status: 'ok',
  };

  if (check.blockers.length && !options.force) {
    result.status = 'blocked';
    result.reason = '预检未通过，未打开页面';
    result.hint = titleGuard.suggestFix(item.title) !== item.title ? '标题修正建议: ' + titleGuard.suggestFix(item.title) : '';
    writeJson(path.join(outDir, 'fill-report.json'), result);
    result.outDir = outDir;
    return result;
  }

  const { context } = await connect();
  let page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    if (!catId) throw new Error('没有已打开的发布页，也拿不到类目 ID。请在 item.json 或 selectors.json 里填 catId。');
    page = await openPublishPage(context, selectors.publishUrl || publishUrl(catId));
    await sleep(4000);
  }
  await page.bringToFront().catch(() => {});

  if (isLoginUrl(page.url())) {
    result.status = 'login-required';
    result.reason = '页面跳转到登录页: ' + page.url();
    writeJson(path.join(outDir, 'fill-report.json'), result);
    result.outDir = outDir;
    return result;
  }

  const riskBefore = await detectRiskSignals(page);
  if (riskBefore.length && !options.ignoreRisk) {
    result.status = 'blocked';
    result.riskSignals = riskBefore;
    result.reason = '页面在填写前就出现风控信号';
    result.screenshot = await screenshot(page, outDir, 'before-fill');
    writeJson(path.join(outDir, 'fill-report.json'), result);
    result.outDir = outDir;
    return result;
  }

  for (const rule of rules) {
    await applyRule({ rule, item, itemDir, page, report: result.report, rows: check.rows, selectors });
  }

  result.errorMarkers = await readErrorMarkers(page);
  result.riskSignals = await detectRiskSignals(page);
  result.screenshot = await screenshot(page, outDir, 'after-fill');

  const failed = result.report.filter((r) => r.status === 'failed');
  if (result.riskSignals.length) {
    result.status = 'blocked';
    result.reason = '填写过程中出现风控信号，当天批次应停止';
  } else if (failed.length) {
    result.status = 'partial';
    result.reason = failed.length + ' 项没填成功';
  }

  if (options.submit && result.status === 'ok') {
    result.submit = await submitItem(page, selectors);
    result.submitted = Boolean(result.submit && result.submit.ok);
    if (result.submit && !result.submit.ok) result.status = 'partial';
  }

  writeJson(path.join(outDir, 'fill-report.json'), result);
  result.outDir = outDir;
  return result;
}

module.exports = { runFill, preflight, findSelectors, submitItem, effectiveTitle };
