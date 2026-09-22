'use strict';

// 把发布页的「型号」字段填成当前北京时间，格式 YYYY+M+D+HH+MM（月日不补零）。
// 例：2026/9/21 19:48 → 20269211948

const {
  connect,
  sleep,
  realType,
  screenshot,
  ensureDir,
} = require('C:/Users/Administrator/.codex/skills/taobao-phonecase-listing/scripts/lib/browser');

function buildCode(now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return { code: `${y}${m}${d}${hh}${mm}`, readable: `${y}/${m}/${d} ${hh}:${mm}` };
}

async function readModelInput(page) {
  return page.evaluate(() => {
    // 注意：id 里带 ~ ，直接写进选择器会被当成兄弟选择器解析出错，
    // 所以这里用 getElementById 精确取。
    const candidates = ['sell-field-p-20000~1', 'struct-p-20000~1'];
    for (const id of candidates) {
      const node = document.getElementById(id);
      if (!node) continue;
      const input = node.querySelector('input');
      if (input) {
        return { id, value: String(input.value || '') };
      }
    }
    return null;
  });
}

async function main() {
  ensureDir('D:/AutoTaobao/taobao-case/_listing-work/model-number');

  const now = new Date();
  const { code, readable } = buildCode(now);
  console.log('当前北京时间: ' + readable);
  console.log('换算成型号: ' + code + '（' + code.length + ' 字符）');

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  const before = await readModelInput(page);
  console.log('改前: ' + JSON.stringify(before));
  if (!before) {
    console.error('没定位到「型号」输入框');
    process.exit(1);
  }

  // 型号输入框是组件库托管的，用真实键盘输入最稳
  // Playwright 的 CSS 选择器里 ~ 要转义成 \~
  await realType(page, '#' + before.id.replace(/~/g, '\\~') + ' input', code, 0);
  await sleep(2000);

  const after = await readModelInput(page);
  console.log('改后: ' + JSON.stringify(after));
  const ok = after && after.value === code;
  console.log('写入: ' + (ok ? '成功' : '不一致，需要人工确认'));
  console.log('截图: ' + (await screenshot(page, 'D:/AutoTaobao/taobao-case/_listing-work/model-number', 'after')));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('失败: ' + err.message);
  process.exit(1);
});

