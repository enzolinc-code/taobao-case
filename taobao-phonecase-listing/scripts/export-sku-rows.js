#!/usr/bin/env node
'use strict';

// 把商品数据算成「SKU 批量导入表」需要的行列，输出 JSON 到 stdout。
// 复用 fill-core 的预检：解析机型清单、展开机型×颜色矩阵、生成商家编码。
// 列名来自官方模板 SKU模板_<catId>_*.xls，必须逐字一致。

const fs = require('fs');
const path = require('path');
const { getArg, readJson } = require('./lib/browser');
const { preflight, findSelectors } = require('./lib/fill-core');

const TEMPLATE_COLUMNS = [
  '图案类型',
  '适用手机型号',
  '颜色分类',
  '功能',
  '价格',
  '数量',
  '商家编码',
  '商品条形码',
  '装饰元素',
  'SKU搜索主图',
  'SKU搜索标题',
  '是否上架',
];

const DIRECT_FIELDS = {
  价格: 'price',
  数量: 'stock',
  商家编码: 'outerId',
};

function main() {
  const itemArg = getArg('item');
  if (!itemArg) {
    console.error('用法: node export-sku-rows.js --item <商品文件夹>/item.json [--selectors <selectors.json>] [--force]');
    process.exit(1);
  }
  const itemPath = path.resolve(itemArg);
  if (!fs.existsSync(itemPath)) {
    console.error('找不到 ' + itemPath);
    process.exit(1);
  }
  const itemDir = path.dirname(itemPath);
  const item = readJson(itemPath);

  const selectorsPath = findSelectors(getArg('selectors'), itemDir);
  const selectors = selectorsPath ? readJson(selectorsPath) : {};
  const check = preflight(item, selectors, itemDir);

  if (check.blockers.length && !process.argv.includes('--force')) {
    console.error('预检未通过，先修数据：');
    for (const blocker of check.blockers) console.error('  - ' + blocker);
    process.exit(1);
  }

  const rows = check.rows.map((row) =>
    TEMPLATE_COLUMNS.map((column) => {
      const field = DIRECT_FIELDS[column];
      if (field) {
        const value = row[field];
        return value === null || value === undefined ? '' : value;
      }
      if (column === '商品条形码' || column === 'SKU搜索主图' || column === 'SKU搜索标题') return '';
      if (column === '是否上架') return item.liveFlag === undefined ? 1 : item.liveFlag;
      return row.axes[column] !== undefined ? row.axes[column] : '';
    })
  );

  process.stdout.write(
    JSON.stringify({
      catId: item.catId || null,
      columns: TEMPLATE_COLUMNS,
      usedAxes: Object.keys(check.skuSummary.axisValueCounts),
      summary: check.skuSummary,
      warnings: check.warnings,
      rows,
    })
  );
}

main();
