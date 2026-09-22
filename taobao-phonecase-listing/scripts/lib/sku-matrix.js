'use strict';

// 手机壳的 SKU 是"机型 × 颜色/图案"的矩阵，几十行是常态，一个链接几百行也不稀奇。
// 这个模块只做纯计算：展开矩阵、校验、切片。不碰页面，可以单独测。

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const NON_AXIS_KEYS = ['price', 'stock', 'outerId'];

// 模板里的 "_说明" 这类注释键不是轴，参与笛卡尔积会凭空多出一行。
function isAxisKey(key) {
  return !NON_AXIS_KEYS.includes(key) && !String(key).startsWith('_');
}

function axisNames(item) {
  if (item.axes && typeof item.axes === 'object' && Object.keys(item.axes).length) {
    return Object.keys(item.axes).filter(isAxisKey);
  }
  const first = Array.isArray(item.skus) && item.skus.length ? item.skus[0] : null;
  if (!first) return [];
  return Object.keys(first).filter(isAxisKey);
}

function cartesian(axes) {
  return Object.keys(axes).filter(isAxisKey).reduce(
    (rows, name) => {
      const values = Array.isArray(axes[name]) ? axes[name] : [axes[name]];
      const next = [];
      for (const row of rows) {
        for (const value of values) next.push({ ...row, [name]: value });
      }
      return next;
    },
    [{}]
  );
}

function rowKey(axes) {
  return Object.keys(axes)
    .sort()
    .map((k) => k + '=' + axes[k])
    .join('|');
}

// 优先用显式 skus（每行可以有自己的价格/库存）；没有就按 axes 展开，套用商品级默认值。
function expand(item) {
  const defaults = {
    price: toNumber(item.price),
    stock: toNumber(item.stock),
    outerId: item.outerId || '',
  };

  if (Array.isArray(item.skus) && item.skus.length) {
    return item.skus.map((sku) => {
      const axes = {};
      for (const key of Object.keys(sku)) {
        if (isAxisKey(key)) axes[key] = sku[key];
      }
      const ownOuterId = sku.outerId || '';
      return {
        axes,
        key: rowKey(axes),
        price: toNumber(sku.price !== undefined ? sku.price : defaults.price),
        stock: toNumber(sku.stock !== undefined ? sku.stock : defaults.stock),
        outerId: ownOuterId || defaults.outerId,
        // 显式写在自己这一行上的编码才是"不可覆盖"的；继承来的商品级货号只是前缀。
        outerIdExplicit: Boolean(ownOuterId),
      };
    });
  }

  if (!axisNames(item).length) return [];
  return cartesian(item.axes).map((axes) => ({
    axes,
    key: rowKey(axes),
    price: defaults.price,
    stock: defaults.stock,
    // 轴展开出来的行没有天然编码：要么用 outerIdPattern 生成，要么留空。
    outerId: '',
    outerIdExplicit: false,
  }));
}

// maxRows 不设默认值：平台上限必须实测，写死在脚本里只会变成错误的权威。
function validate(rows, options = {}) {
  const issues = [];
  const warnings = [];

  if (!rows.length) {
    issues.push('没有 SKU 行：item.json 里既没有 skus，也没有可展开的 axes');
    return { issues, warnings };
  }

  const seen = new Map();
  rows.forEach((row, index) => {
    const label = '第' + (index + 1) + '行 ' + row.key;
    if (seen.has(row.key)) {
      issues.push('SKU 重复：' + label + ' 与第' + (seen.get(row.key) + 1) + ' 行的轴值完全相同');
    } else {
      seen.set(row.key, index);
    }

    const emptyAxes = Object.entries(row.axes)
      .filter(([, value]) => value === '' || value === null || value === undefined)
      .map(([name]) => name);
    if (emptyAxes.length) issues.push(label + ' 轴值为空：' + emptyAxes.join(', '));

    if (row.price === null) issues.push(label + ' 价格不是数字');
    else if (row.price <= 0) issues.push(label + ' 价格必须大于 0（当前 ' + row.price + '）');

    if (row.stock === null) issues.push(label + ' 库存不是数字');
    else if (row.stock < 0) issues.push(label + ' 库存不能为负（当前 ' + row.stock + '）');
  });

  if (options.maxRows && rows.length > options.maxRows) {
    issues.push(
      'SKU 行数 ' + rows.length + ' 超过 selectors.json 配置的 maxSkuRows=' + options.maxRows +
        '，先确认这个类目的实测上限再继续'
    );
  }
  if (rows.length > 500) {
    warnings.push('SKU 行数 ' + rows.length + '，发布页渲染和保存都会很慢，建议先用小批量验证');
  }
  return { issues, warnings };
}

function chunk(rows, size) {
  const n = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

function summarize(rows) {
  const axisValueCounts = {};
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.axes)) {
      axisValueCounts[name] = axisValueCounts[name] || new Set();
      axisValueCounts[name].add(value);
    }
  }
  const counts = {};
  for (const [name, set] of Object.entries(axisValueCounts)) counts[name] = set.size;

  const prices = rows.map((r) => r.price).filter((p) => p !== null);
  const stocks = rows.map((r) => r.stock).filter((s) => s !== null);
  return {
    rows: rows.length,
    axisValueCounts: counts,
    priceRange: prices.length ? [Math.min(...prices), Math.max(...prices)] : null,
    stockTotal: stocks.length ? stocks.reduce((a, b) => a + b, 0) : null,
  };
}

module.exports = { expand, validate, chunk, summarize, rowKey, cartesian, axisNames, isAxisKey };
