#!/usr/bin/env node
'use strict';

// 一条命令跑完整条自动化上架链路（把已分别验证过的脚本串起来）：
//   1. 打开「发布相似品」复制页（可选，--copy-from <源商品ID>）
//   2. 素材批量上传到「全部图片」（可选，--upload）
//   3. 换标题
//   4. 主图 1:1 + 3:4（一次多选填满）
//   5. SKU 颜色图（抽屉里启用颜色图模式 → 一次多选）
//   6. 详情图（一次多选）
//   7. 型号（北京时间 YYYY+M+D+HH+MM）
//   8. 提交并关闭页面（可选，--submit；提交前会先打状态快照，成功后自动关标签页）
//
// 不做的：批量上传（用 bulk-upload-assets.js 单独跑一次）、SKU 颜色图（人工）、提交（人工）。
//
// 用法: node pipeline-new-listing.js --item <item.json> [--copy-from 1083698755183]
//   [--upload]  上传素材   [--submit]  填完并提交后关闭页面

const path = require('path');
const { spawnSync } = require('child_process');
const { connect, sleep, getArg } = require('./lib/browser');

const HERE = __dirname;

function runStep(label, script, args) {
  console.log('');
  console.log('══════ ' + label);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = ((result.stdout || '') + (result.stderr || '')).trim();
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(output);
  const ok = result.status === 0;
  console.log('────── ' + (ok ? '✅ 完成' : '❌ 失败') + '（' + seconds + ' 秒）');
  return { label, ok, seconds, output };
}

async function openCopyPage(sourceId) {
  const url =
    'https://item.upload.taobao.com/sell/v2/publish.htm?copyItem=true&itemId=' +
    encodeURIComponent(sourceId) +
    '&fromAIPublish=true';
  const { context } = await connect();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(9000);
  await page.bringToFront().catch(() => {});
  return page.url();
}

async function main() {
  const itemArg = getArg('item');
  if (!itemArg) {
    console.error('用法: node pipeline-new-listing.js --item <item.json> [--copy-from <源商品ID>]');
    process.exit(1);
  }
  const itemPath = path.resolve(itemArg);
  const item = require(itemPath);
  const dir = path.resolve(path.dirname(itemPath), item.assetsDir);

  console.log('商品配置: ' + itemPath);
  console.log('图片目录: ' + dir);

  const steps = [];

  const copyFrom = getArg('copy-from');
  if (copyFrom) {
    console.log('');
    console.log('══════ 1. 发布相似品复制（源商品 ' + copyFrom + '）');
    const url = await openCopyPage(copyFrom);
    console.log('已打开: ' + url.slice(0, 100));
    console.log('────── ✅ 完成');
    steps.push({ label: '复制页', ok: true, seconds: 0 });
  }

  if (process.argv.includes('--upload')) {
    // --keep-picker-open：上传完成后**不关素材中心**，交给下一步直接选 3:4 主图，
    // 省掉"关弹窗 → 下一步再开弹窗"的一来一回（约 5 秒）。
    // ⚠️ --early-done-after 默认 0（等全部传完）—— 这是踩过坑之后的决定，别改回去：
    //
    // 曾经默认 6（只等 6 个回执就去选图，剩下的在后台继续传）。结果 **062/063/064 三条链接
    // 的第 5 张主图全错**：素材库里有大量**同名**的 主图3比4_05.jpg（来自之前的设计），
    // 我们新传的那张还没传完，按名字匹配时命中了别人的旧文件。
    // 根因不是"关面板会取消上传"，而是**同名文件 + 提前选图**。
    //
    // 所以必须等 16 个回执全到齐再选图（此时新文件已在列表最前，按名字选中它）。
    // 个别场景想省几秒可手动调大/调小，但**不要在有同名文件的素材库里用**。
    // --upload-1x1：走"上传 1:1 主图 + 手选"的老做法，**不调用**页面裁剪接口
    // （imageCutUtil/autoCutImages —— 2026-09-23 触发平台风控的就是它）。
    // 代价：多传 5 张、多开一次素材中心，每条约多 10–15 秒。被风控期间建议用它。
    const useUpload1x1 = process.argv.includes('--upload-1x1');
    const upArgs = ['--dir', dir, '--keep-picker-open'];
    if (useUpload1x1) upArgs.push('--with-1x1');
    const earlyIdx = process.argv.indexOf('--early-done-after');
    const early = earlyIdx > -1 && process.argv[earlyIdx + 1] != null ? process.argv[earlyIdx + 1] : '0';
    upArgs.push('--early-done-after', early);
    const uploadStep = runStep('2. 素材批量上传到「全部图片」', 'bulk-upload-assets.js', upArgs);
    steps.push(uploadStep);
    // 【安全闸】上传这一步没成功就立刻停整条流程。
    // 原因：往下的每一步（主图/SKU 图/详情图/白底图）都是"按文件名去素材库里挑"，
    // 而素材库里有大量同名文件。上传没成功时挑到的会是别人更早的同名旧图 ——
    // 2026-09-22（062–064 第 5 张主图）和 2026-09-23（104/105）两次事故都是这么造成的。
    // 宁可停下来，也不要带着错图往下走。
    if (!uploadStep.ok) {
      console.log('');
      console.log('══════ 已中止流程（不继续填图）');
      console.log('  素材上传没有成功，失败原因见上一步的输出。');
      console.log('  继续往下会按文件名挑图，上传失败时会挑到别人的同名旧图。');
      console.log('  处理方式：先让上传恢复正常（例如在受控浏览器里过一次人机验证），再用同一条命令重跑。');
      process.exit(2);
    }
  }
  // 顺序说明：素材刚传完就紧接着做主图 —— 此时素材中心是热的、弹窗状态最干净，
  // 主图又是最不能出错的一项，先做完再处理标题等次要字段。
  // 标题放在主图之后，避免打字/失焦把素材中心的目录状态搅乱。
  //
  // 【2026-09-22 起】主图只传/只选 3:4 那 5 张，1:1 用页面自带的
  // 「从3:4主图裁剪」生成 —— 少传 5 张图、少开一次素材中心。
  // 想恢复"1:1 也上传并手选"，把 --group 改回 both 并去掉 --derive-main，
  // 上传步骤同时加 --with-1x1。
  const useUpload1x1ForMain = process.argv.includes('--upload-1x1');
  steps.push(
    useUpload1x1ForMain
      ? runStep('3. 主图（1:1 + 3:4，各自上传手选；不走裁剪接口）', 'fill-main-images.js', ['--dir', dir, '--group', 'both'])
      : runStep('3. 主图（填 3:4，再由 3:4 裁出 1:1）', 'fill-main-images.js', ['--dir', dir, '--group', 'main34', '--derive-main'])
  );
  steps.push(runStep('4. 换标题', 'set-listing-title.js', ['--item', itemPath]));
  steps.push(runStep('5. SKU 颜色图（一次多选）', 'fill-sku-color-images.js', ['--dir', dir]));
  steps.push(runStep('6. 详情图（一次多选）', 'fill-detail-images.js', ['--dir', dir]));
  // 白底图：默认用目录里的 SKU_1（800x800 正视图纯白底），结果可控。
  // 页面的「从主图生成」实测挑的是第 5 张斜拍图、且无法指定源图，所以不采用；要试加 --generate。
  steps.push(runStep('7. 白底图（放 SKU_1）', 'fill-white-bg-image.js', ['--dir', dir]));
  // 型号：模板商品里已经写死固定值，复制时会一起带过来
  //（实测：复制页的「改前」就是模板里的值），所以默认不再用北京时间覆盖它。
  // 需要恢复旧行为时加 --set-model。
  if (process.argv.includes('--set-model')) {
    steps.push(runStep('8. 型号（北京时间，可选）', 'set-model-number.js', []));
  }

  if (process.argv.includes('--submit')) {
    // 【安全闸】前面任何一步失败就不提交。
    // 不堵住的话，会带着 --submit 把一个残缺的链接提交上去。
    const failed = steps.filter((s) => !s.ok);
    if (failed.length) {
      console.log('');
      console.log('══════ 已跳过提交');
      console.log('  前面有 ' + failed.length + ' 步失败：' + failed.map((s) => s.label).join('、'));
      console.log('  修好这些步骤后再加 --submit 重跑，不要硬提交。');
      steps.push({ label: '提交（已跳过）', ok: false, seconds: 0 });
    } else {
      steps.push(runStep('8. 提交并关闭页面', 'submit-listing.js', []));
    }
  }

  console.log('');
  console.log('══════ 汇总');
  let total = 0;
  for (const s of steps) {
    total += s.seconds;
    console.log('  ' + (s.ok ? '✅' : '❌') + ' ' + s.label + '  ' + s.seconds + ' 秒');
  }
  console.log('  合计 ' + total + ' 秒');
  console.log('');
  console.log(
    process.argv.includes('--submit')
      ? '已完成全流程（含提交）。'
      : '还差最后一步：加 --submit 跑提交（或手动点）。'
  );
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error('流程失败: ' + err.message);
  process.exit(1);
});
