# 淘宝手机壳自动上架

把自有工厂的手机壳商品**批量上架到淘宝卖家中心**的半自动化工具。
一次运行约 2 分钟，把一条复制模板 → 上传素材 → 换图 → 换标题 → 提交的全流程跑完，
人都可以不管；批量时一条失败会整批停下。

> 这是给**个人店铺**用的浏览器自动化方案：通过 CDP 接管一个已登录的 Chrome，
> 而不是走淘宝开放平台 API。原因是个人店铺拿不到那些接口权限。

---

## 一、它能做什么

一条链接的完整流程（`pipeline-new-listing.js`）：

| 步骤 | 脚本 | 做什么 |
|---|---|---|
| 1 | （内联） | 用「发布相似宝贝」复制一个模板商品 |
| 2 | `bulk-upload-assets.js` | 把该商品目录下的 21 张图**一次性**传进图片空间 |
| 3 | `fill-main-images.js` | 填主图：1:1 五张 + 3:4 五张（各一次多选） |
| 4 | `set-listing-title.js` | 换标题：`图片目录名 + 固定后缀` |
| 5 | `fill-sku-color-images.js` | 填 SKU 颜色图三张 |
| 6 | `fill-detail-images.js` | 清空继承来的旧详情，放入 8 张详情图 |
| 7 | `fill-white-bg-image.js` | 白底图位置放 `SKU_1` 那张图 |
| 8 | `submit-listing.js` | 提交并关闭页面，回读基础分 |

**耗时实测**：单条约 **89 秒**（含提交约 100 秒）。这个数字是从最初 289 秒一步步压下来的，
详见 [工作记录-2026-09-22.md](工作记录-2026-09-22.md) 里记录的几轮优化。

> **主图/白底图的做法**：3:4 主图从素材目录上传并选取，**1:1 主图由页面自带的
> 「从3:4主图裁剪」生成**（因此 1:1 那 5 张不上传）；**白底图用目录里的 `SKU_1`
> （800×800 正视图、纯白底）**。
>
> 为什么白底图不用页面「从主图生成」：实测它**不是随机**（三次结果一致），但挑中的是
> 第 5 张斜拍主图，而且**点选主图、删除重生成都无法影响它**——无法指定源图。想要正视图只能用 SKU_1。
>
> 回退/替换参数：上传加 `--with-1x1` 恢复传 1:1；主图用 `--group both`（不带 `--derive-main`）
> 恢复手选；白底图加 `--generate` 改用页面生成。

> **截图策略**：成功路径默认**不截图**（发布页整页约 5000 像素高，一张 0.7–1 MB，
> 每步都截会拖慢十几秒并堆出几百 MB）；**出错时才自动截图**。
> 需要留证时加 `--shots` 参数，或设环境变量 `TAOBAO_SHOTS=1`。

批量：

```bash
node taobao-phonecase-listing/scripts/batch-new-listing.js 038 039 040
```

---

## 二、目录结构

```
taobao-phonecase-listing/     ← 技能本体（SKILL.md + scripts + references + assets）
商品-手机壳-0NN/item.json      ← 每条链接的上架配置（素材目录、价格、库存、商家编码前缀）
商品图片/<设计名>/             ← 素材目录，目录名就是标题前缀（不入库）
机型清单.json                  ← 71 机型 × 3 颜色，全店共用
上架台账.md                    ← 已上架链接的唯一清单（ID、标题、基础分、状态）
上架ID-*.txt                   ← 已上架商品 ID（逐行 / 逗号分隔）
工作记录-YYYY-MM-DD.md         ← 每天的进展、踩过的坑、验证结论
_listing-work/                ← 运行产物：截图、报告、诊断脚本（不入库）
```

---

## 三、前置条件

1. **Chrome**，用独立 profile 带调试端口启动（**每天开工都要重新拉一次**，
   窗口关掉端口就没了；登录态存在 profile 里不会丢）：

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --remote-debugging-port=9222 `
     --user-data-dir="C:\Users\<你的用户名>\taobao-automation-profile"
   ```

   启动后**在这个窗口里手动登录一次**卖家中心，之后保持登录即可。

2. **Node.js** + Playwright（技能能自动从 Codex 运行时里找，也可用
   `TAOBAO_SKILL_NODE_MODULES` 指定 node_modules 路径）。

3. 检查环境是否就绪：

   ```bash
   node taobao-phonecase-listing/scripts/check-env.js
   ```

---

## 四、素材目录的命名规则（重要）

每个商品一个目录，固定 **21 张**，文件名必须严格按下面来——脚本靠名字选图：

```
主图_1 … 主图_5              1:1 主图（5 张）
主图3比4_01 … 主图3比4_05    3:4 主图（5 张）
SKU_1_全包精孔软壳            颜色图，序号对应颜色轴第 1/2/3 个颜色
SKU_2_磨砂大孔二合一
SKU_3_磁吸磨砂二合一
详情图_1 … 详情图_8           详情图（8 张）
删除*.jpg                    会被自动跳过
```

目录名本身就是标题前缀，标题 = `目录名 + 固定后缀`。

**素材不齐会拒绝上架**：目录里少于 21 张或命名对不上，脚本会直接停下并报缺失清单。
这道检查拦下过一条只拷了一半的素材，避免了发布残次品。

---

## 五、新建一条链接

1. 把素材放进 `商品图片/<设计名>/`
2. 复制上一条的配置：`商品-手机壳-0NN/item.json`，只改三个字段
   （`assetsDir` / `outerId` / `notes`）——**`titleSuffix` 直接沿用，不要手打**
3. 跑：

   ```bash
   node taobao-phonecase-listing/scripts/batch-new-listing.js 0NN
   ```

---

## 六、几个必须知道的坑

这些都是一次次踩出来的，改代码前建议先看一眼：

- **槽位菜单只在真实鼠标轨迹下出现** —— Playwright 的 `hover()` 触发不了，
  必须用 CDP `Input.dispatchMouseEvent` 派发 `mouseMoved` 序列。
- **点击前必须先 `scrollIntoView`** —— 按钮在视口外时坐标是负数，
  点了不报错也不生效。
- **素材中心 iframe 是常驻挂载的** —— 弹窗关着它也在 DOM 里，
  判断弹窗要看 `.next-overlay-wrapper.opened` 里有没有它、且宽度 > 100（高度可能是 0）。
- **「本地上传」会直接弹出系统文件框** —— 必须**先挂** `filechooser` 监听再点它，
  否则真实的 Windows 对话框会弹到桌面上并一直留着。
- **不能用 `offsetParent` 判断弹窗可见性** —— 确认弹窗是 `position: fixed`，
  而 fixed 元素的 `offsetParent` 恒为 `null`，会造成"明明开着却判成没开"、每次白等满超时。
- **详情图要先清空再插** —— 复制过来的旧详情必须清掉，否则会混进模板商品的图。

更完整的说明见 [taobao-phonecase-listing/references/troubleshooting.md](taobao-phonecase-listing/references/troubleshooting.md)。

---

## 七、合规与风险（请自行判断）

- 标题里的品牌词是**关键词堆砌**写法，存在平台规则风险，由使用者自行承担。
- 本方案用浏览器自动化模拟人工操作，**不是官方接口**；
  平台规则变化可能导致流程失效，需要重新校准。
- 批量上架注意**重复铺货**风险。

---

## 八、相关文档

| 文件 | 内容 |
|---|---|
| [上架台账.md](上架台账.md) | 已上架链接清单与状态 |
| [工作记录-2026-09-20.md](工作记录-2026-09-20.md) | 流程搭建、最初的坑 |
| [工作记录-2026-09-21.md](工作记录-2026-09-21.md) | 效率优化、首次整条编排跑通 |
| [工作记录-2026-09-22.md](工作记录-2026-09-22.md) | 批量上架、两轮提速（289→117 秒） |
| [taobao-phonecase-listing/SKILL.md](taobao-phonecase-listing/SKILL.md) | 技能说明书 |
