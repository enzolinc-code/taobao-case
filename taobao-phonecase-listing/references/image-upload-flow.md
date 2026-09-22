# 图片上传流程（真人录制还原）

这份文档来自一次完整的真人操作录制（`_listing-work/recording-3`，249 条事件 + 80 条接口记录），
覆盖从「我的产品」列表到提交的全过程。**照着做，不要在弹窗里盲试。**

## 一、整体链路

```text
卖家中心 → 在售商品（SellManage/on_sale）
  └ 目标商品那一行 → 「更多」→「发布相似品」
      └ 发布页（publish.htm?copyItem=true&itemId=…）
          ├ 改标题：全选删除 → 逐字输入（受控组件，见下）
          ├ 主图 1:1（5 张）：七步流程 ×N
          ├ 主图 3:4（5 张）：七步流程 ×N
          ├ 详情页：清空 → 确定 → 加「图片」模块 → 七步流程 ×N
          └ 上架时间：放入仓库 / 立刻上架 / 定时上架
```

## 二、图片上传的七步（关键）

每一步都实测过，**少任何一步都不生效**：

| 步 | 动作 | 目标 |
|---|---|---|
| 1 | 点上传槽「上传图片」 | `.image-list > .drag-item:nth-of-type(N) … .upload-text` |
| 2 | 弹窗里点「本地上传」 | iframe 内 `button.next-btn.next-btn-primary` |
| 3 | 点上传区触发文件框 | `#sucai-tu-upload`（文案「点击/拖拽，批量导入文件」） |
| 4 | 选文件 | 原生文件选择框 |
| 5 | 点「完成」 | `.UploadPanel_footerBtn` |
| 6 | 回列表里勾选该图 | `label.next-checkbox-wrapper > input.next-checkbox-input` |
| 7 | 点「确定（N）」 | `.Footer_selectOk`（文案形如「确定（1）」） |

### 为什么第 5、6、7 步都要

- 只做 1–5：图进了**图片空间**，但槽位还是空的。
- 做到 1–6：勾选状态有了，但不点「确定（N）」同样不落位。
- 第 7 步是真正的提交动作，之前两轮失败都卡在这里。

### 多选同一个弹窗

同一个弹窗里可以连续勾选多张（录屏里连续点了 5 次「图片 → 复选框」），
然后一次性点「确定（N）」。N 就是勾选数量。

## 三、弹窗的状态陷阱（我踩过的坑）

**素材中心的 iframe 是常驻挂载的**，弹窗关闭时它仍然在 DOM 里（只是隐藏）。
所以：

- `page.frames().find(f => f.url().includes('sucai-selector-ng'))` **永远能找到**这个 iframe；
- 在弹窗没打开时点它里面的按钮，会点到隐藏元素或残留状态上——**不报错，也不生效**；
- 判断"弹窗是否真的打开了"，要看主文档里的弹窗容器，不能只看 iframe 是否存在。

## 三之二、槽位操作菜单必须用真实鼠标轨迹触发

主图槽位悬停后会出现操作菜单：**裁剪 / 替换 / 删除 / AI 作图**。

这个菜单**用 Playwright 的 `hover()` 触发不了**——前端用了事件委托，只有真实鼠标轨迹才会被识别。
必须用 CDP 直接派发一串 `Input.dispatchMouseEvent` 的 `mouseMoved`，从远处逐步靠近槽位中心：

```js
const client = await page.context().newCDPSession(page);
const path = [[cx - 160, cy - 120], [cx - 90, cy - 60], [cx - 30, cy - 20], [cx, cy], [cx + 2, cy + 1], [cx, cy]];
for (const [x, y] of path) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(110);
}
```

菜单出来后在 `li.next-menu-item` 里按文案取坐标，再用同样的 CDP 通道点击。

**主图是有「替换」的**——我一开始因为 hover 触发不了菜单，误判成"只能删了重传"，这个判断是错的。

## 三之三、勾选图片要用 DOM 派发点击

图片列表的复选框是自定义组件，真实 `input` 被隐藏，Playwright 的 `click()`
（即使加 `force: true`）会报 `Element is not visible`。正确做法是直接派发 DOM 事件：

```js
await input.evaluate((el) => {
  el.click();
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
```

另外，卡片上的文件名**不在复选框那一层**，要往上找 3～5 级才能拿到
（形如 `主图_1.jpg 1440x1440`）。

## 四、详情页的图

详情页用的是**同一套弹窗**，前面多两步：

1. 点「清空」（`#panel_edit` 头部）→ 弹确认框点「确定」（清掉复制过来的旧详情）
2. 点「图片」（`.add_component… .add_item` 里的模块按钮）插入图片模块
3. 之后就是上面的七步流程

## 五、接口层看到的（供以后判断能不能绕开 UI）

录制期间发布页调用的、与图片有关的接口：

| 接口 | 次数 | 说明 |
|---|---|---|
| `stream-upload.taobao.com/api/upload.api` | 6 | 真正的图片上传 |
| `item.upload.taobao.com/sell/batch/image/detail` | 5 | 批量图片详情 |
| `…mtop.taobao.picturecenter.console.file.query/1.0/` | 8 | 图片空间文件查询 |
| `…mtop.taobao.picturecenter.console.dir.query/1.0/` | 5 | 图片空间目录查询 |
| `item.upload.taobao.com/sell/v2/asyncOpt.htm` | 8 | 发布页的异步操作 |

这些是 mtop 接口，带签名（`_m_h5_tk`），**直接调用等于自己实现签名和会话管理**，
维护成本高于走 UI。除非上传量级大到 UI 走不动，否则不建议绕。

## 六、标题必须逐字输入

录屏里 94 个字符产生了 94 条 input 事件——标题输入框是受控组件，
`element.value = x` 之类的直接赋值不会被前端框架采纳，必须真实键盘输入
（脚本里的 `realType` 就是这个）。

## 六之二、SKU 颜色图（人工步骤，自动化未跑通）

SKU 颜色图的入口藏得比主图深，**建议直接人工操作**。完整的操作链路如下
（来自录屏 `_listing-work/recording-5`，109 个事件）：

```text
1. SKU 面板点「设置」(.sku-decouple-message > button)
   → 右侧抽屉 div.next-drawer.next-drawer-right 打开

2. 抽屉「属性」区点「颜色分类」

3. 页面上 #struct-p-228680323 里的「添加图片」复选框 → 勾上
   （注意：不在抽屉里，是页面上那个容器里的复选框标签）

4. #struct-p-1627207（颜色分类属性容器）里出现颜色项列表：
   #struct-p-1627207 > div > ul.sell-color-item-container > div:nth-of-type(N) > li
   每个 li 里有 div.sell-color-option-image-upload —— 就是单个颜色的图片上传口

5. 逐个颜色项：点 sell-color-option-image-upload → 素材中心选图 → 确定
   （确认按钮在 div.next-dialog.batch-fill-sku-image-dialog 里）

6. 抽屉底部点「确认创建」收尾
```

### 为什么没自动化

试过三种写法都不稳定：

| 写法 | 结果 |
|---|---|
| Playwright 点击各按钮 | 被事件委托挡掉，无反应 |
| CDP 真实鼠标轨迹 + 点击 | 抽屉有时开有时不开 |
| 按录制选择器逐步复现 | 卡在「添加图片」这一步，容器定位随页面状态漂移 |

根因是这个抽屉的打开依赖页面滚动位置和前置状态，跟主图槽位菜单那种"位置固定"的控件不一样。
**三个颜色图人工点三次约一分钟，投入产出比远高于继续调脚本。**

### 顺带记两条坑

- **`Escape` 会关掉整个抽屉**，不是只关菜单。脚本在循环里按 Escape 清状态，会把后面全搞垮。
- 抽屉是 `div.next-drawer`，**不是** `.next-dialog`。找容器时别找错，否则怎么扫都是空的。

## 七、上架时间

`.sell-shelf-time` 下的第 3 个选项是「放入仓库」。
批量上新建议默认用它：先把商品建好、人工过一遍，再上架。
