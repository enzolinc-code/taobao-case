# SKU 表：手机壳的主战场

手机壳一个链接通常是"一个图案/系列 × 几十个机型"，SKU 行数=机型数（×颜色数）。这部分填错，
后果是买家拍错型号、退货、差评——比标题填错严重得多。所以这一节请按顺序校准，不要跳步。

## 一、先搞清楚这个类目的 SKU 轴是什么

不同类目的销售属性不一样，可能是"适用机型 + 颜色分类"，也可能是"型号 + 图案"。
**以 probe 输出为准**：

```bash
node <skill>/scripts/probe-publish-page.js --cat-id <手机壳类目ID>
```

看输出里的 `SKU 区` 段：

- `struct-p-XXXX` 就是销售属性容器，有几个就是几个轴，`XXXX` 是属性 ID。
- 表格的列头告诉你有几列（机型、颜色、价格、数量、编码……）。
- 明细在 `probe.json` 的 `page.skuArea` 里，包含每个容器的输入框选择器和表格第一行的单元格结构。

## 二、把轴写进 selectors.json

`sku.axes` 的键名必须和 `item.json` 里 `axes` 的键名一致，脚本靠这个对上：

```json
"sku": {
  "axes": {
    "适用机型": { "strategy": "addValue", "selector": "#struct-p-XXXX input", "addIndex": 0 },
    "颜色":     { "strategy": "choose",   "selector": "#struct-p-YYYY .xxx", "index": 0 }
  }
}
```

两种轴的处理方式不一样：

| 轴的类型 | strategy | 什么时候用 |
|---|---|---|
| 下拉可选（颜色、材质这类封闭枚举） | `choose` | 选项在平台给定的列表里 |
| 需要自己新增（机型这种长尾值） | `addValue` | 页面提供"自定义/新增"输入框，输入后回车或点添加 |
| 输入框但不需要新增动作 | `type` / `native` | 实测哪种能生效用哪种 |

**机型几乎一定是 `addValue`**：平台不可能把几百个机型型号都做成固定选项。

## 三、把表格列写进 selectors.json

```json
"table": {
  "rowSelector": "table tbody tr",
  "cells": {
    "price":   { "strategy": "type", "selector": "input[placeholder*='价格']" },
    "stock":   { "strategy": "type", "selector": "input[placeholder*='数量']" },
    "outerId": { "strategy": "type", "selector": "input[placeholder*='编码']" }
  }
}
```

脚本**不按列序号定位**，而是逐行读取行文本，判断是否包含该 SKU 的全部轴值，命中才填。
列顺序变了不用改配置。

## 四、先在一条商品上试跑

```bash
node <skill>/scripts/fill-listing.js --item 商品\某款\item.json
```

看报告里的三类信息：

1. `[OK] skus — 成功 N/M 行`：行数对不对（应该等于轴值数量的乘积）。
2. `失败: skus — …：表格里找不到轴值匹配的行`：说明轴值没加进表格，或者轴值文案和表格里显示的不完全一致。
3. 页面错误标记：SKU 相关的报错会出现在这里（价格为空、数量为空、轴值非法）。

**先让 SKU 全绿再开批量。** 批量跑一个填不对的 SKU 配置，等于批量生产错误链接。

## 五、常见坑

| 症状 | 原因 | 处理 |
|---|---|---|
| 轴值加不进去 | 输入框需要先点"自定义/添加"，或者要回车确认 | 换 `addValue`，确认 `selector` 指向的是输入框而不是外层容器 |
| 表格行数不对 | 轴值有重复，或某个轴值没被接受 | 用 `sku-matrix.js` 的校验输出看重复行；重复值平台会合并 |
| 同一行反复填不上 | 表格是虚拟滚动，只渲染可见行 | 先滚动到该行再填；行数很多时分批（脚本已经逐行处理，但页面渲染慢时需要拉长 `TAOBAO_PACE_*`） |
| 价格/库存填了没生效 | 用了直接赋值的老办法 | 把该列 strategy 换成 `native` 或保留 `type` 但确认按了 Tab |
| 机型文案对不上 | `item.json` 写的机型名和表格里显示的不是同一串字 | 以平台原词为准，改 `item.json` |

## 六、规模提醒

一个链接几十行 SKU，300 个链接就是上万次输入。所以：

- 先用 1 个链接验证配置，再用 5 个链接验证稳定性，最后才开全量。
- 每次批量都留账本（`_listing-work/ledger.jsonl`），出问题能定位到具体的商品和行。
- SKU 轴值列表集中维护在 `机型清单.json` 里，不要在几百个 item.json 里各写一遍（见 [model-list.md](model-list.md)）。
