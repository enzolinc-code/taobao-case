#!/usr/bin/env node
'use strict';

// 关掉发布页上遗留的弹窗 / 浮层。
// 背景：填 SKU 颜色图那一步结束时，页面常留一个需要点「确定」的弹窗，
//       不关掉的话，后面一步（详情图）会点不到东西而失败。
//
// 用法: node dismiss-dialogs.js [--expect <文字片段>]
//   只点确认类按钮，不点提交、不点保存草稿。

const { connect, sleep, getArg } = require('./lib/browser');

const CONFIRM_TEXTS = ['确定', '确认', '确定关闭', '关闭', '知道了', '知道了，不再提示'];
// 这一条是"警告型"弹窗：文案说明"确定取消会导致已上传的颜色分类图丢失"，
// 点「确定」会把刚传好的颜色图丢掉，所以只点"留下/继续"那一侧。
const KEEP_TEXT_PATTERNS = [/会导致已上传的颜色分类图丢失/, /已上传.*丢失/, /确定要取消/];
const KEEP_TEXTS = ['取消', '继续编辑', '继续', '返回', '留下', '不取消'];

async function main() {
  const expect = getArg('expect');
  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布宝贝页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await sleep(500);

  let closed = 0;
  for (let round = 0; round < 4; round++) {
    const info = await page.evaluate(
      (texts, keepPatterns, keepTexts) => {
        const textOf = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
        const patterns = (keepPatterns || []).map((src) => new RegExp(src));
        const opened = Array.from(document.querySelectorAll('.next-overlay-wrapper.opened'))
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return { el, text: textOf(el), width: Math.round(rect.width), height: Math.round(rect.height) };
          })
          .filter((item) => item.width > 100 && (item.text || item.el.querySelector('button, iframe')));
        let count = 0;
        const clicked = [];
        for (const item of opened.reverse()) {
          // 警告型弹窗：只点"留下/继续"，绝不点确定
          const keep = patterns.some((re) => re.test(item.text));
          if (keep) {
            const stayButton = Array.from(item.el.querySelectorAll('button')).find((b) =>
              keepTexts.includes(textOf(b))
            );
            if (stayButton) {
              stayButton.click();
              count++;
              clicked.push('保留:' + textOf(stayButton));
              continue;
            }
            const closeIcon = Array.from(item.el.querySelectorAll('[class*="close" i]')).find(
              (el) => el.offsetWidth || el.offsetHeight
            );
            if (closeIcon) {
              closeIcon.click();
              count++;
              clicked.push('保留:close-icon');
            }
            continue;
          }
          const button = Array.from(item.el.querySelectorAll('button')).find((b) =>
            texts.includes(textOf(b))
          );
          if (button) {
            button.click();
            count++;
            clicked.push(textOf(button));
            continue;
          }
          const closeIcon = Array.from(item.el.querySelectorAll('[class*="close" i]')).find(
            (el) => el.offsetWidth || el.offsetHeight
          );
          if (closeIcon) {
            closeIcon.click();
            count++;
            clicked.push('close-icon');
          }
        }
        return { opened: opened.length, count, clicked };
      },
      CONFIRM_TEXTS,
      KEEP_TEXT_PATTERNS.map((re) => re.source),
      KEEP_TEXTS
    );
    if (expect) console.log('（本次期待包含「' + expect + '」）');
    console.log('第 ' + (round + 1) + ' 轮：打开 ' + info.opened + ' 个，点了 ' + info.count + ' 个 ' + JSON.stringify(info.clicked));
    closed += info.count;
    if (!info.count) break;
    await sleep(1500);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);
  const left = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.next-overlay-wrapper.opened'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        })
        .filter((box) => box.width > 100 && box.height > 100).length
  );

  console.log('共关闭 ' + closed + ' 个弹窗；仍可见的大浮层 ' + left + ' 个');
  console.log('=== 只关闭弹窗，没有提交、没有保存。 ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
