---
name: taobao-phonecase-listing
description: 把自有工厂的手机壳商品半自动上架到淘宝卖家中心发布宝贝页：通过 CDP 接管已登录的 Chrome，按 item.json 填标题、类目属性、机型×颜色 SKU 矩阵、价格、库存和主图，可单件跑也可按账本批量跑，默认停在提交前；也能只读导出参考商品页的类目属性与 SKU 结构供对照。适用于淘宝手机壳/手机配件类目的新商品发布与批量上新；不适用于选品分析、生意参谋数据采集、客服回复、订单发货。
---

# 淘宝手机壳批量上架

把一个商品文件夹变成发布页上"已填好、只差点提交"的状态；批量时串行跑、有账本、有刹车。

## 铁律

1. **默认不提交。** 单件要提交得显式加 `--submit`；批量提交还要再加 `--i-know`。
2. **绝不重启浏览器。** 通过 CDP 接管已经在运行的 Chrome；重启会丢登录态，也容易触发风控。
3. **验证即停。** 滑块、短信、人脸、二次验证、"操作过于频繁"——立刻停下报告，不要重试硬闯。
4. **登录由真人完成。** 检测到登录页就停，不代填账号密码。
5. **首次类目必须人工核对。** 新类目的属性映射、SKU 轴、图片要求，第一次由真人看一遍再放开批量。
6. **品牌词必须带"适用于"。** 手机壳属于平台明文要求的叶子类目，预检不过不发车（见 references/compliance.md）。
7. **预算与限频。** 批量默认每日 10 个、任务间 20–60 秒随机停顿。这是保守起点不是平台限额，先小批量实测再逐档放宽。

## 工作流

### 0.（可选）读一个参考商品页

跟款或对照时，先在你已登录的 Chrome 里导出参考页结构：

```bash
node <skill>/scripts/read-reference-item.js --id <商品ID>
```

只读，不点任何按钮。产出全页截图 + `reference.json`（标题、价格线索、SKU 取值、属性行、图片地址）。
**参考的是类目、属性、SKU 结构这类事实信息**；标题和详情文案要自己写，照搬会被投诉并判重复铺货
（见 [references/compliance.md](references/compliance.md)）。

### 1. 准备机型清单和商品文件夹

**机型清单全店一份**，放在商品文件夹的上一级，`item.json` 引用它——新增或下架机型只改这一个文件，
避免几百个文件里机型写法不一致导致 SKU 行匹配不上。模板见 `assets/model-list.template.json`，
维护方式、筛选语法、自动生成商家编码见 [references/model-list.md](references/model-list.md)。

```text
项目根\
├── 机型清单.json          ← 全店共用
├── 商品-黑猫-001\
│   ├── item.json
│   └── images\
│       ├── main-01.jpg
│       └── color-black.jpg
└── 商品-星空-002\
    └── item.json
```

`item.json` 的字段说明和模板见 `assets/item.template.json`。SKU 三种写法：`axes` 里直接给数组、
引用机型清单（推荐），或给 `skus` 数组逐行指定价格库存。

### 2. 检查环境

```bash
node <skill>/scripts/check-env.js
```

确认 Chrome 带调试端口在跑、登录态还在。连不上时会打印可直接粘贴的启动命令。
这个窗口要一直开着（独立 profile，和日常浏览器互不干扰）。

### 3. 校准发布页（每个类目只做一次）

```bash
node <skill>/scripts/probe-publish-page.js --cat-id <手机壳类目ID>
```

输出控件清单、**SKU 区的销售属性容器和表格结构**、错误标记和截图。
按实测结果写 `selectors.json`（参考 `assets/selectors.template.json`）。
SKU 部分的校准细节见 [references/sku-table.md](references/sku-table.md)。

**不要凭猜测写选择器。** 填不准的字段先写 `"strategy": "manual"`。

### 4. 单件试跑

```bash
node <skill>/scripts/resolve-item.js --item 商品\某款\item.json
node <skill>/scripts/fill-listing.js --item 商品\某款\item.json
```

先干跑（不碰浏览器）确认机型、SKU 行数、编码和拦截项；没问题再打开发布页。
脚本会先做预检（标题合规、SKU 完整性），通过后才打开发布页填。**不点提交。**
报告里会列出成功项、失败项、页面错误标记和风控信号。

### 5. 人工核对并提交

逐项核对：类目、属性、SKU 行数与价格库存、图片顺序、品牌词写法。
批量上新建议把上架时间选**"放入仓库"**，建好再人工上架。
页面上出现"错误(N)"就把报错文字反馈回来，用于补 `selectors.json`。

### 6. 整条流水线：复制模板 → 换图 → 提交（当前在用的路径）

上面第 4、5 步走的是 `fill-listing.js`（按 Excel 填属性/SKU）。
**如果商品是"复制一条已有链接当模板，再换成自己的图和标题"，用下面这条更省事**——
从复制到提交一步到位，中途不需要人工。

```bash
# 单条
node <skill>/scripts/pipeline-new-listing.js \
  --item 商品-手机壳-00X/item.json \
  --copy-from <模板商品ID> \
  --upload --submit \
  --out _listing-work

# 批量（推荐，按顺序逐条跑，任何一条失败立即停止）
node <skill>/scripts/batch-new-listing.js 011 012 013
```

它依次做 8 件事：发布相似宝贝 → 21 张素材批量上传到图片空间「全部图片」→ 换标题 →
主图 1:1 与 3:4（各一次多选）→ SKU 颜色图 ×3 → 详情图 ×8 → 型号（北京时间）→ 提交并关闭页面。
实测单条约 4.6 分钟，八条连续跑 38 分钟，平均 289 秒，波动 ±1.4%。

**安全闸**：前面任何一步失败就不提交，避免把残缺链接发出去；批量时失败整批停止，
并提示从哪一条接着跑。

开始前必须确认：Chrome 带 `--remote-debugging-port=9222` 在跑（每天开工要重新拉一次窗口，
登录态在独立 profile 里，不会丢）；`item.json` 里 `titleSuffix` 直接沿用已有配置，**不要手打**。

模板商品 ID 和「发布相似宝贝」的关系、图片槽位的操作陷阱 → [references/image-upload-flow.md](references/image-upload-flow.md)

### 7. 另一种批量：按 Excel 表填属性（老路径）

```bash
node <skill>/scripts/resolve-item.js --scan 商品
node <skill>/scripts/batch-publish.js --items 商品\款A,商品\款B
node <skill>/scripts/batch-publish.js --batch 商品\batch.json --per-day 20
```

这条走 `fill-listing.js`，适合"属性/SKU 从 Excel 来"的场景，**不带图片上传和提交**。
别和上面第 6 节混用。

- 批量前先 `--scan` 干跑一遍：能在开浏览器之前发现清单路径、分组名、SKU 行数、编码的问题；
- 自动跳过账本里已完成的商品（`--force` 可重跑）；
- 命中风控或登录失效 → 整批中止，剩余标记 `not-started`；
- 连续 3 个失败 → 停止，提示先修配置；
- 账本在 `_listing-work/ledger.jsonl`，本批小结在 `_listing-work/batch-*/batch-summary.json`。

### 8. 记录

把商品 ID、上架时间、失败项写回商品文件夹，避免同一件重复跑。

## 参考资料

- 手机壳发布字段、标题红线、图片与重复铺货 → [references/publish-fields.md](references/publish-fields.md)
- 图片上传的七步流程与弹窗状态陷阱 → [references/image-upload-flow.md](references/image-upload-flow.md)
- 机型清单怎么维护、怎么按商品筛选 → [references/model-list.md](references/model-list.md)
- SKU 表怎么校准和填 → [references/sku-table.md](references/sku-table.md)
- 合规边界、人机分工、批量预算 → [references/compliance.md](references/compliance.md)
- 填不进去怎么查 → [references/troubleshooting.md](references/troubleshooting.md)

改版或字段对不上时，先重跑 probe 重新校准，再考虑改脚本——**优先改配置**。
