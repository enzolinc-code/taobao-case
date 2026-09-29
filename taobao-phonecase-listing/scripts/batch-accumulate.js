#!/usr/bin/env node
'use strict';

// 按"分批累积 → 用清单发布"的流程连续上架一批商品（2026-09-26 定型的做法）。
//
// 为什么要这个脚本：限流紧的时候，"整批 21 张一次投递"必被拒，必须
//   ① 用 --chunk 6 小批投递、② 用 --merge-manifest 跨轮累积、
//   ③ 凑齐 21 张后再用现成清单发布（不加 --upload，不重复上传）。
// 手工跑这两步要来回切命令、看输出，容易漏；这里把它固化，并且**一旦窗口关了就自动停**。
//
// 用法:
//   node batch-accumulate.js 436 437 438 ...
//   node batch-accumulate.js --copy-from 1083698755183 --chunk 6 --max 6 436 437 ...
//
// 行为:
//   逐条：累积上传（必要时重试 2 次）→ 清单齐 21 张才发布 → 发布成功后继续下一条；
//   若某条的上传 0/N（窗口关闭）→ 立刻停止整批（不再空耗额度）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, '_listing-work');

// 同步等待（main() 是同步的，用不了 setTimeout）
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function getArg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}

const copyFrom = getArg('copy-from', '1083698755183');
const chunk = getArg('chunk', '6');
const maxItems = Number(getArg('max', '0'));
// 解析商品编号：要把"选项后面的值"排除掉（否则 `--max 6` 里的 6 会被当成 006 号商品）。
// 【2026-09-27 踩过】第一次跑就因为这个 bug 报"006 素材目录不存在"并直接退出。
const FLAGS_WITH_VALUE = ['--copy-from', '--chunk', '--max', '--out'];
const argv = process.argv.slice(2);
const nums = [];
for (let i = 0; i < argv.length; i++) {
  if (FLAGS_WITH_VALUE.includes(argv[i])) {
    i++; // 跳过它的值
    continue;
  }
  if (/^\d{1,4}$/.test(argv[i])) nums.push(String(argv[i]).padStart(3, '0'));
}
if (maxItems > 0) nums.length = Math.min(nums.length, maxItems);
if (!nums.length) {
  console.error('用法: node batch-accumulate.js [--copy-from <id>] [--chunk 6] [--max N] 436 437 ...');
  process.exit(1);
}

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: ((r.stdout || '') + (r.stderr || '')).trim(),
  };
}

function lastLines(text, n) {
  return text.split(/\r?\n/).slice(-n).join('\n');
}

function manifestCount(dirName) {
  const f = path.join(OUT, 'manifests', dirName + '.json');
  if (!fs.existsSync(f)) return 0;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).count || 0;
  } catch (e) {
    return 0;
  }
}

// 发布是否成功：找这次运行之后新出的、标题匹配的 submit-report
function publishedOk(design, sinceMs) {
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('submit-'));
  for (const d of dirs) {
    const f = path.join(OUT, d, 'submit-report.json');
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    if (st.mtimeMs < sinceMs) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const title = (j.snapshot && j.snapshot.title) || '';
      if (title.startsWith(design) && j.result && j.result.kind === 'success') return j.result.text.match(/商品ID[：:]\s*(\d+)/);
    } catch (e) {
      /* 忽略坏报告 */
    }
  }
  return null;
}

// 【2026-09-29 加】这条设计以前成功上架过没有（不限时间，只看本地提交报告）。
// 用途：台账还没记账时，"待上架"会算错，脚本就会把已经上过的再发一遍 → 重复铺货。
// 639 已经这样出过一次重复，所以这里默认拦住；确实要重发就加 --allow-republish。
const ALLOW_REPUBLISH = process.argv.includes('--allow-republish');
function alreadyPublished(design) {
  if (!fs.existsSync(OUT)) return null;
  for (const d of fs.readdirSync(OUT).filter((x) => x.startsWith('submit-'))) {
    const f = path.join(OUT, d, 'submit-report.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const title = (j.snapshot && j.snapshot.title) || '';
      if (title.startsWith(design) && j.result && j.result.kind === 'success') {
        const m = j.result.text.match(/商品ID[：:]\s*(\d+)/);
        return m ? m[1] : '（ID 未读出来）';
      }
    } catch (e) {
      /* 忽略坏报告 */
    }
  }
  return null;
}

function main() {
  const done = [];
  let stopped = null;

  for (const no of nums) {
    const itemPath = path.join(ROOT, '商品-手机壳-' + no, 'item.json');
    if (!fs.existsSync(itemPath)) {
      stopped = no + ' 没有配置文件';
      break;
    }
    const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    const design = path.basename(item.assetsDir);
    const dirPath = path.resolve(path.dirname(itemPath), item.assetsDir);
    if (!fs.existsSync(dirPath)) {
      stopped = no + ' 素材目录不存在: ' + dirPath;
      break;
    }

    console.log('');
    console.log('████ ' + no + '  ' + design + '（已累积 ' + manifestCount(design) + '/21）████');

    // ── 0. 确保桌面上有一张发布页（上传步骤依赖它；提交成功后会被 submit-listing 关掉）──
    // 【2026-09-28 加】以前靠人工在批量前开一张，结果发布时流程又开一张 →
    // 桌面上同时两张发布页（用户反馈"发布一个宝贝打开 2 次发布页"）。
    // 现在每条开跑前自动确认，配合 pipeline 的"复用已有发布页"，全程只留一张。
    const ensure = run('ensure-publish-page.js', ['150704']);
    console.log('  ' + lastLines(ensure.out, 1));

    // ── 1. 累积上传（最多 3 轮：首次 + 2 次补）──────────────────
    let count = manifestCount(design);
    for (let attempt = 0; attempt < 3 && count < 21; attempt++) {
      const up = run('bulk-upload-assets.js', [
        '--dir', dirPath,
        '--with-1x1',
        '--chunk', chunk,
        '--merge-manifest',
        '--out', OUT,
      ]);
      const m = up.out.match(/上传结果: 成功 (\d+)\/(\d+)/);
      count = manifestCount(design);
      console.log('  上传第 ' + (attempt + 1) + ' 轮：' + (m ? m[0] : lastLines(up.out, 1)) +
        '，累计 ' + count + '/21');
      if (count >= 21) break;
      if (m && m[1] === '0') {
        stopped = no + '：本轮上传 0 张，窗口已关';
        break;
      }
    }
    if (stopped) break;
    if (count < 21) {
      stopped = no + '：累积只到 ' + count + '/21，本轮先停（下次接着累积）';
      break;
    }

    // ── 2. 用现成清单发布（不加 --upload）──────────────────────
    const dup = alreadyPublished(design);
    if (dup && !ALLOW_REPUBLISH) {
      console.log('  ⏭ 该设计已有成功提交记录（ID ' + dup + '），跳过以免重复上架');
      console.log('    （确实要重发：在命令后加 --allow-republish）');
      done.push({ no, design, id: dup, skipped: true });
      continue;
    }
    const startedAt = Date.now();
    const pub = run('pipeline-new-listing.js', [
      '--item', path.join('商品-手机壳-' + no, 'item.json'),
      '--copy-from', copyFrom,
      '--submit',
      // 【2026-09-27 必须有】用页面「从3:4主图裁剪生成1:1」那条路会调
      // imageCutUtil/autoCutImages 接口 —— 实测它会**触发平台滑块验证**，
      // 验证框盖住页面后，主图/标题/SKU/详情/白底全部点不动（439 就是这么失败的）。
      // 加 --upload-1x1 后改为"直接用清单里的 主图_N 手选"，不再调用裁剪接口。
      '--upload-1x1',
      '--out', OUT,
    ]);
    // 【2026-09-29 修】提交报告是 submit-listing.js **写完后**父进程才可能读到，
    // 之前立刻查会出现"明明发布成功、却报发布未成功"的竞态（545 就是这么误判的）。
    // 这里改成最多等 24 秒，每 3 秒查一次。
    let idm = publishedOk(design, startedAt - 5000);
    for (let wait = 0; !idm && wait < 8; wait++) {
      sleepSync(3000);
      idm = publishedOk(design, startedAt - 5000);
    }
    // 【2026-09-29 加】兜底：本地没有提交报告 **不代表没发出去**。
    // 639 就是这样：报"未成功"，其实平台已经上架，脚本重跑就多出一条重复链接。
    // 所以这里去后台按标题搜一次，搜到就视为成功（并提醒报告缺失）。
    if (!idm) {
      const find = spawnSync(process.execPath, [path.join(HERE, 'find-item-by-title.js'), design], { encoding: 'utf8' });
      const foundId = (find.stdout || '').trim().split(/\r?\n/)[0];
      if (find.status === 0 && /^\d{9,}$/.test(foundId)) {
        console.log('  ⚠️ 本地没有提交报告，但后台已存在该标题（ID ' + foundId + '）→ 视为发布成功，不再重跑');
        idm = [null, foundId];
      }
    }
    if (idm) {
      console.log('  ✅ 发布成功：' + idm[1]);
      done.push({ no, design, id: idm[1] });
    } else {
      console.log('  ❌ 发布未成功，最后几行：');
      console.log(lastLines(pub.out, 8));
      stopped = no + '：发布未成功（草稿可能还在，需要人工看）';
      break;
    }
  }

  console.log('');
  console.log('══════ 本轮结果 ══════');
  for (const d of done) console.log('  ' + (d.skipped ? '⏭ 已上架过' : '✅') + ' ' + d.no + ' ' + d.design + '  ' + d.id);
  console.log('  成功 ' + done.length + ' 条');
  if (stopped) console.log('  ⛔ 停止原因：' + stopped);
  const ids = done.map((d) => d.id);
  if (ids.length) console.log('  ID: ' + ids.join(','));
  process.exit(done.length ? 0 : 1);
}

main();
