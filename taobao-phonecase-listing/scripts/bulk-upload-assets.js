#!/usr/bin/env node
'use strict';

// 把产品图片目录里的图**一次性**传进图片空间（素材中心），跳过「删除*」命名的文件。
//
// 为什么要这一步：原来的流程是"每个位置点开弹窗 → 本地上传 → 传一张 → 完成"，
// 10 张主图要重复 10 次上传，大部分时间耗在这上面。
// 素材中心的上传控件支持多选（实测 multiple=true），所以先整批传进去，
// 后面各个位置只需要「按文件名挑」——挑比传快得多。
//
// 【2026-09-22 起】默认**不传 1:1 主图（主图_N.jpg）**：发布页的 1:1 主图可以直接
// 用「从3:4主图裁剪」生成，那 5 张就不必上传、也不必挑了。要恢复传全部，加 --with-1x1。
//
// 用法: node bulk-upload-assets.js --dir <产品图片目录> [--limit N]

const fs = require('fs');
const path = require('path');
const {
  connect,
  sleep,
  waitUntil,
  waitForPickerContent,
  switchToAllImages,
  screenshot,
  ensureDir,
  getArg,
  detectRiskSignals,
} = require('./lib/browser');

const IMAGE_EXT = /\.(jpg|jpeg|png|webp|bmp|gif)$/i;
// 这些前缀不传：删除*（用户标记的废图），说明文件
const SKIP_PREFIX = ['删除', '_'];

const SELECTOR_IFRAME = 'sucai-selector-ng';

function firstLineOf(s) {
  return String(s || '').split('\n')[0].slice(0, 200);
}

function pickerOpen(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('.next-overlay-wrapper.opened')).some(
        (o) => o.querySelector('iframe[src*="sucai-selector-ng"]') && o.getBoundingClientRect().width > 100
      )
    )
    .catch(() => false);
}

async function openImageSelector(page, client) {
  // 优先用已有槽位：空槽直接点；满了就用悬停菜单里的「替换」
  // 【2026-09-22】改成**优先从 3:4 主图区**打开：上传完这个弹窗不关，
  // 下一步选 3:4 就直接在里面选，少一次「关弹窗→再开弹窗」。
  const containers = ['#struct-threeToFourImages', '#struct-mainImagesGroup'];
  for (const selector of containers) {
    const scope = page.locator(selector).first();
    if (!(await scope.count())) continue;

    const emptySlot = scope.locator('.main-content.medium.dashed').first();
    if (await emptySlot.count()) {
      await emptySlot.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(600);
      await emptySlot.click();
      const opened = await waitUntil(() => pickerOpen(page), { timeoutMs: 8000, intervalMs: 300, minMs: 400 });
      if (opened.ok) return true;
    }

    // 没有空槽：用 CDP 轨迹悬停第一个已填槽位，点菜单里的「替换」
    const filled = scope.locator('.drag-item').first();
    if (!(await filled.count())) continue;
    await filled.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(600);
    const box = await filled.boundingBox();
    if (!box) continue;
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    for (const [x, y] of [[cx - 120, cy - 80], [cx - 40, cy - 20], [cx, cy], [cx + 2, cy + 1], [cx, cy]]) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
      await sleep(110);
    }
    await sleep(2000);
    const replace = page.locator('li.next-menu-item').filter({ hasText: /^替换$/ }).first();
    if (await replace.count()) {
      await replace.click();
      const opened = await waitUntil(() => pickerOpen(page), { timeoutMs: 8000, intervalMs: 300, minMs: 400 });
      if (opened.ok) return true;
    }
  }
  return false;
}

async function main() {
  const dir = getArg('dir');
  if (!dir) {
    console.error('用法: node bulk-upload-assets.js --dir <产品图片目录> [--limit N]');
    process.exit(1);
  }
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    console.error('找不到目录: ' + root);
    process.exit(1);
  }

  let files = fs
    .readdirSync(root)
    .filter((name) => IMAGE_EXT.test(name))
    .filter((name) => !SKIP_PREFIX.some((prefix) => name.startsWith(prefix)))
    // 默认跳过 1:1 主图（主图_1.jpg … 主图_5.jpg）；注意别误伤 主图3比4_01.jpg
    .filter((name) => process.argv.includes('--with-1x1') || !/^主图_\d/.test(name))
    .map((name) => path.join(root, name));
  const limit = Number(getArg('limit') || 0);
  if (limit > 0) files = files.slice(0, limit);

  if (!files.length) {
    console.error('目录里没有可上传的图（已排除「删除*」）');
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const outDir = path.join(outRoot, 'bulk-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outDir);

  const { context } = await connect();
  const page = context.pages().find((p) => p.url().includes('publish.htm'));
  if (!page) {
    console.error('没找到发布页');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(1500);

  const client = await page.context().newCDPSession(page);
  console.log('打开图片选择器…');
  if (!(await openImageSelector(page, client))) {
    console.error('没能打开素材中心（图片选择器）');
    process.exit(1);
  }

  let frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));

  // 弹窗出现不代表 iframe 内容渲染好了。不等这一步，下面找「全部图片」会找不到，
  // 上传就会落到「复制宝贝」自动建的目录里（实测踩过）。
  const contentReady = await waitForPickerContent(page, { timeoutMs: 8000 });
  console.log('   素材中心内容就绪用了 ' + contentReady.ms + ' ms' + (contentReady.ok ? '' : '（超时）'));
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;

  // 先切到「全部图片」根目录：不切的话会落在「复制宝贝」自动建的目录里，
  // 后面按名字挑图就找不到（这个坑今天踩了两次）。
  // 已在的话直接跳过；不在才点，并等它真的变成选中态。
  const sw = await switchToAllImages(page);
  console.log('已切到「全部图片」目录: ' + (sw.ok ? (sw.alreadyThere ? '本来就在（0 秒）' : sw.ms + ' ms') : '失败'));
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;

  console.log('一次性投递 ' + files.length + ' 个文件:');
  files.forEach((f) => console.log('    ' + path.basename(f)));

  // ── 关键：先挂监听，再点任何东西 ─────────────────────────────
  // 只要页面上有 filechooser 监听在，Playwright 就会**拦住**系统文件框；
  // 没有监听的时候点「本地上传」，Windows 的「打开」对话框会真的弹到桌面上、
  // 而且不会自己关掉——就是截图里那个一直挂着的窗口。
  let pendingChooser = null;
  const grabChooser = (c) => {
    if (!pendingChooser) pendingChooser = c;
  };
  page.on('filechooser', grabChooser);

  let chooser = null;
  const localUpload = frame.locator('button:has-text("本地上传")').first();
  if (await localUpload.count()) {
    await localUpload.click();
    // 有的版本点「本地上传」直接弹文件框，有的只是展开上传区，等 3 秒看是哪种
    for (let i = 0; i < 12 && !pendingChooser; i++) await sleep(250);
    if (pendingChooser) {
      console.log('   「本地上传」直接触发了文件框（已被拦截，不再点上传区）');
      chooser = pendingChooser;
    }
  }

  if (!chooser) {
    await waitUntil(
      () =>
        frame
          .evaluate(() => Boolean(document.querySelector('#sucai-tu-upload') || document.querySelector('input[type=file]')))
          .catch(() => false),
      { timeoutMs: 6000, intervalMs: 250, minMs: 400 }
    );
    const uploadArea = frame.locator('#sucai-tu-upload').first();
    const clickTarget = (await uploadArea.count()) ? uploadArea : frame.locator('input[type=file]').first();
    await clickTarget.click();
    for (let i = 0; i < 40 && !pendingChooser; i++) await sleep(250);
    chooser = pendingChooser;
  }

  page.off('filechooser', grabChooser);
  if (!chooser) {
    console.error('没能拿到文件选择器（上传入口没找到）');
    process.exit(1);
  }

  // ── 上传完成的判断：听接口，不靠盲等 ──────────────────────────────
  // 图片空间的上传链路（2026-09-22 抓包确认）：
  //   POST https://stream-upload.taobao.com/api/upload.api  → 每个文件一个请求，
  //        200 且响应体里有 object.fileId 才算这个文件被平台收下；
  //   随后客户端轮询 GET .../api/collect_client_upload_rt.api?file_Id=... 做异步处理。
  // 实测 3 张图 5 秒内就全部收下，而老写法按"每张 2.5 秒、至少 20 秒"硬等 52 秒，
  // 21 张时白等 40 秒以上。改成：收齐 N 个 200 就立刻关面板。
  const accepted = [];
  const failed = [];
  // 【必须】被风控拒绝的文件：HTTP 也是 200，但响应体是
  // {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
  //  "data":{"url":".../api/upload.api/_____tmd_____/punish?x5secdata=..."}}
  // 2026-09-23 教训：只看 HTTP 200 会把"被拒绝"当成"传成功"，
  // 后面按名字选图就选到别人更早的同名文件 —— 两条链接的图就是这么错的。
  const rejected = [];
  // 【硬校验用】把"这次刚上传的 文件名 → 图片编号(O1CN...)"记下来。
  // 素材库里同名文件很多，后续按名字选图时必须核对选中的是不是"这次传的"，
  // 否则可能命中别人的旧文件（2026-09-22 出过这个事故：062–064 第 5 张主图错）。
  const uploaded = [];
  // 解析失败时留证据：把 upload.api 的原始响应体（截断）转存，便于排查为什么没解析出文件名
  const rawBodies = [];
  let successMarker = false;
  const onResponse = async (res) => {
    const u = res.url();
    if (!u.includes('/api/upload.api')) return;
    if (res.status() !== 200) {
      failed.push(res.status());
      return;
    }
    try {
      const body = await res.text();
      rawBodies.push({ url: u.slice(0, 120), status: res.status(), len: body.length, head: body.slice(0, 200) });
      if (/FAIL_SYS_USER_VALIDATE|_tmd_____\/punish|x5secdata/.test(body)) {
        rejected.push({ status: res.status(), head: body.slice(0, 120) });
        return;
      }
      if (!/"fileId"/.test(body)) {
        rejected.push({ status: res.status(), head: body.slice(0, 120) });
        return;
      }
      const m = body.match(/"fileId"\s*:\s*"?(\d+)/);
      accepted.push(m ? m[1] : 'unknown');
      const fn = (body.match(/"fileName"\s*:\s*"([^"]+)"/) || [])[1] || null;
      const oid = (body.match(/(O1CN[A-Za-z0-9]+)/) || [])[1] || null;
      if (fn && oid) uploaded.push({ file: fn, oid });
    } catch (e) {
      accepted.push('unknown');
      rawBodies.push({ url: u.slice(0, 120), status: res.status(), error: firstLineOf(e.message) });
    }
  };
  page.on('response', onResponse);

  const t0 = Date.now();
  await chooser.setFiles(files);
  console.log('已投递 ' + files.length + ' 个文件，按接口回执判断完成…');

  // 要等多少个回执才继续？默认等全部（files.length）。
  // --early-done-after N：只等 N 个就先关面板去干别的（剩下的文件在浏览器里继续传）。
  // 用途：3:4 主图是第 4–8 个传的，等它们到了就能先去选图，不必干等 16 个全传完。
  const earlyArg = Number(getArg('early-done-after') || 0);
  const needCount = earlyArg > 0 && earlyArg < files.length ? earlyArg : files.length;

  const hardCapMs = Math.max(60000, files.length * 6000);
  let waited = 0;
  while (waited < hardCapMs) {
    if (accepted.length + failed.length >= needCount) break;
    await sleep(400);
    waited += 400;
    if (waited % 4000 === 0) {
      console.log('    …已收 ' + (accepted.length + failed.length) + '/' + files.length + ' 个回执');
    }
  }
  const acceptMs = Date.now() - t0;
  if (needCount < files.length) {
    console.log('   已收 ' + (accepted.length + failed.length) + ' 个回执（够用），先关面板去选图；剩下的在浏览器里继续传');
  }

  // 面板上出现"上传成功"再收尾；最多再等 8 秒，等不到也继续（接口已经回执了）。
  // 但"边传边选"模式下不等这一步 —— 目的就是别再干等，剩下的交给浏览器。
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;
  if (needCount >= files.length) {
    for (let i = 0; i < 20; i++) {
      successMarker = await frame
        .evaluate(() =>
          /上传成功|上传完成|\d+\s*\/\s*\d+/.test(document.body ? document.body.innerText : '')
        )
        .catch(() => false);
      if (successMarker) break;
      await sleep(400);
    }
  }
  const totalMs = Date.now() - t0;
  const oldWaitMs = Math.max(20000, files.length * 2500);
  console.log(
    '   平台回执 ' + accepted.length + '/' + files.length + ' 个，用时 ' + acceptMs + ' ms' +
      (failed.length ? '，失败 ' + failed.length + ' 个' : '') +
      '；旧写法要等 ' + oldWaitMs + ' ms'
  );
  page.off('response', onResponse);

  // 落一份"本次上传清单"，给后面的选图步骤做逐张核对用
  const uploadedFile = path.join(outRoot, 'last-upload.json');
  fs.writeFileSync(path.join(outRoot, 'last-upload-raw.json'), JSON.stringify(rawBodies, null, 2), 'utf8');
  fs.writeFileSync(
    uploadedFile,
    JSON.stringify({ dir: root, at: new Date().toISOString(), count: uploaded.length, files: uploaded }, null, 2),
    'utf8'
  );
  console.log('   本次上传清单: ' + uploaded.length + ' 个文件 → ' + uploadedFile);

  if (needCount >= files.length && accepted.length < files.length) {
    console.log('⚠️ 没有收齐回执（' + accepted.length + '/' + files.length + '），继续按老逻辑再等一会儿');
    await sleep(8000);
  }

  const waitMs = oldWaitMs;

  // 【关键】上传完必须点「完成」把上传面板收掉。
  // 不关的话，面板会一直盖在上面（还有"N 个文件上传成功"的提示），
  // 后面的选图就会被这层挡住、点不动或点错 —— 这个 bug 之前没修。
  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME)) || frame;
  const doneBtn = frame.locator('button:has-text("完成")').first();
  if (await doneBtn.count()) {
    await doneBtn.click().catch(() => {});
    console.log('已点「完成」关掉上传面板');
    // 等上传面板收掉（老写法固定 5 秒）
    await waitUntil(
      () => frame.evaluate(() => !/拖拽\/粘贴|点击\s+上传文件/.test(document.body ? document.body.innerText : '')).catch(() => false),
      { timeoutMs: 5000, intervalMs: 300, minMs: 800 }
    );
  } else {
    console.log('⚠️ 没找到「完成」按钮，上传面板可能还开着');
  }

  // 弹窗关不关，分两种情况：
  //
  // --keep-picker-open：**保持素材中心开着**，交给下一步（选 3:4 主图）直接在里面选。
  //   这样就省掉了"关弹窗 → 下一步再开弹窗"这一来一回（实测每次约 5 秒）。
  //
  // 默认：整个关掉，让下一个脚本从干净状态开始。
  //   光按 Escape 不行（焦点在 iframe 里，弹窗没反应）——要先点一下页面空白处把焦点移出来。
  //   不关的话，这层会盖住整个页面，下一步点标题/槽位都会被"intercepts pointer events"挡住。
  if (process.argv.includes('--keep-picker-open')) {
    console.log('已按 --keep-picker-open 保持素材中心开着，交给下一步选图');
  } else {
    await page.mouse.click(120, 300).catch(() => {});
    await sleep(800);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(2000);
    const leftovers = await page
      .evaluate(() => document.querySelectorAll('.next-overlay-wrapper.opened').length)
      .catch(() => 0);
    if (leftovers) {
      console.log('⚠️ 还有 ' + leftovers + ' 个浮层没关掉');
    } else {
      console.log('弹窗已全部关闭');
    }
  }

  frame = page.frames().find((f) => f.url().includes(SELECTOR_IFRAME));
  // 上传是否成功，以接口回执为准（上面已收齐 N/N 个），不再去列表里回读"现有卡片"。
  // 那个回读从来没读到过东西（一直是 0），既没意义又要多跑一次 iframe 遍历。
  const risk = await detectRiskSignals(page);
  const shot = await screenshot(page, outDir, 'after-bulk-upload');
  fs.writeFileSync(
    path.join(outDir, 'bulk-upload-report.json'),
    JSON.stringify(
      {
        dir: root,
        fileCount: files.length,
        accepted: accepted.length,
        failedResponses: failed.length,
        acceptMs,
        totalMs,
        successMarkerSeen: successMarker,
        oldWaitMs: waitMs,
        risk,
        screenshot: shot,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('');
  console.log(
    '上传结果: 成功 ' + accepted.length + '/' + files.length +
      (rejected.length ? '，被平台拒绝 ' + rejected.length + ' 个' : '')
  );
  if (rejected.length) {
    console.error('');
    console.error('🚫 有 ' + rejected.length + ' 个文件被平台拒绝 —— 这通常是风控（人机验证）未通过。');
    console.error('   第一个被拒响应的内容: ' + rejected[0].head);
    console.error('   处理：人工在该浏览器里过一次滑块验证，或等风控解除后再跑。');
    console.error('   本次不会继续填图（否则会按名字选到别人更早的同名文件）。');
    process.exit(2);
  }
  if (risk.length) console.log('风控信号: ' + risk.map((r) => r.id).join(', '));
  console.log('=== 只上传到图片空间，没有填任何槽位、没有提交。 ===');

  await page.keyboard.press('Escape').catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('批量上传失败: ' + err.message);
  process.exit(1);
});
