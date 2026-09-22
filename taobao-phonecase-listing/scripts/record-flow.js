#!/usr/bin/env node
'use strict';

// 录制已在运行的 Chrome（CDP 接管）里的鼠标与键盘操作，输出：
//   <out>/events.jsonl  逐条事件（点击/输入/下拉/上传/按键/跳转/下载/接口）
//   <out>/network.jsonl 相关站点的 JSON 响应（用于找商品数据接口）
//   <out>/steps.md      给人看的编号步骤
//   <out>/shots/*.jpg   每次点击的结果截图
//
// 用法：node record-flow.js [--out <目录>] [--endpoint http://127.0.0.1:9222] [--no-shots]
// 停止：Ctrl+C（会先落盘再退出）

const fs = require('fs');
const path = require('path');

const ENDPOINT = readFlag('endpoint') || process.env.REC_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const SHOTS = !process.argv.includes('--no-shots');
const MAX_SHOTS = 800;
const POLL_MS = 400;

const HOST_FILTER = /(^|\.)(vvic|taobao|tmall|alicdn|taobaocdn|1688)\.(com|net)$/i;
const JSON_LIMIT_BYTES = 800 * 1024;
const MAX_BODIES = 80;

function readFlag(name) {
  const idx = process.argv.indexOf('--' + name);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

const NODE_MODULES_CANDIDATES = [
  process.env.REC_SKILL_NODE_MODULES,
  process.env.USERPROFILE
    ? path.join(
        process.env.USERPROFILE,
        '.cache',
        'codex-runtimes',
        'codex-primary-runtime',
        'dependencies',
        'node',
        'node_modules'
      )
    : null,
].filter(Boolean);

function loadPlaywright() {
  const tried = [];
  try {
    return require('playwright');
  } catch (err) {
    tried.push('playwright: ' + String(err.message).split('\n')[0]);
  }
  for (const dir of NODE_MODULES_CANDIDATES) {
    try {
      return require(path.join(dir, 'playwright'));
    } catch (err) {
      tried.push(dir + ': ' + String(err.message).split('\n')[0]);
    }
  }
  throw new Error('加载 playwright 失败。已尝试：\n  ' + tried.join('\n  '));
}

const OUT_DIR = path.resolve(
  readFlag('out') || path.join(process.cwd(), 'recordings', stamp())
);
const SHOTS_DIR = path.join(OUT_DIR, 'shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const STOP_FILE = path.join(OUT_DIR, 'STOP');
const eventsStream = fs.createWriteStream(path.join(OUT_DIR, 'events.jsonl'), { flags: 'a' });
const networkStream = fs.createWriteStream(path.join(OUT_DIR, 'network.jsonl'), { flags: 'a' });

let seq = 0;
let shotCount = 0;
let bodyCount = 0;
let stopping = false;
const counters = { events: 0, clicks: 0, inputs: 0, navs: 0, downloads: 0 };

const INJECT_SRC = fs.readFileSync(path.join(__dirname, 'recorder-inject.js'), 'utf8');

function record(ev, page, frame) {
  const row = Object.assign(
    {
      seq: ++seq,
      iso: new Date().toISOString(),
      pageUrl: page ? page.url() : null,
      frameUrl: frame && frame !== page.mainFrame() ? frame.url() : null
    },
    ev
  );
  eventsStream.write(JSON.stringify(row) + '\n');
  counters.events++;
  if (ev.kind === 'click') counters.clicks++;
  if (ev.kind === 'input' || ev.kind === 'change') counters.inputs++;
  if (ev.kind === 'nav') counters.navs++;
  if (ev.kind === 'download') counters.downloads++;
  describeToConsole(row);
  return row;
}

function describeToConsole(row) {
  const where = (row.pageUrl || '').replace(/^https?:\/\//, '').slice(0, 60);
  let what = row.kind;
  if (row.kind === 'click') {
    const t = row.target || {};
    what = 'click ' + (t.css || t.tag) + ' "' + String(t.text || '').slice(0, 30) + '"';
  } else if (row.kind === 'input' || row.kind === 'change') {
    what = row.kind + ' [' + (row.valueKind || '') + '] = "' + String(row.value || '').slice(0, 60) + '"';
  } else if (row.kind === 'key') {
    what = 'key ' + (row.ctrl ? 'Ctrl+' : '') + row.key;
  } else if (row.kind === 'nav') {
    what = 'nav -> ' + row.url;
  } else if (row.kind === 'download') {
    what = 'download ' + row.suggestedFilename;
  } else if (row.kind === 'paste') {
    what = 'paste "' + String(row.pastedText || '').slice(0, 40) + '"';
  }
  console.log('  [' + row.seq + '] ' + what + '   @ ' + where);
}

function scheduleShot(page, row) {
  if (!SHOTS || shotCount >= MAX_SHOTS) return;
  shotCount++;
  const file = path.join(SHOTS_DIR, String(row.seq).padStart(6, '0') + '.jpg');
  setTimeout(() => {
    Promise.resolve()
      .then(() => page.screenshot({ path: file, type: 'jpeg', quality: 45 }))
      .catch(() => {});
  }, 280);
}

async function injectFrame(frame) {
  try {
    const present = await frame.evaluate(
      '!!(window.__codexRec && window.__codexRec.version)'
    );
    if (!present) await frame.evaluate(INJECT_SRC);
  } catch (err) {
    // chrome:// 等页面无法注入，忽略。
  }
}

async function attachPage(page) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      record({ kind: 'nav', url: frame.url() }, page, null);
    }
  });

  page.on('download', (download) => {
    record(
      {
        kind: 'download',
        suggestedFilename: download.suggestedFilename(),
        url: download.url()
      },
      page,
      null
    );
  });

  page.on('response', async (response) => {
    try {
      if (bodyCount >= MAX_BODIES) return;
      const url = response.url();
      let host;
      try {
        host = new URL(url).hostname;
      } catch (err) {
        return;
      }
      if (!HOST_FILTER.test(host)) return;
      const headers = response.headers() || {};
      const ctype = String(headers['content-type'] || '');
      if (!/json/i.test(ctype)) return;
      const length = Number(headers['content-length'] || 0);
      if (length && length > JSON_LIMIT_BYTES) return;
      const body = await response.text();
      if (!body || body.length > JSON_LIMIT_BYTES) return;
      bodyCount++;
      networkStream.write(
        JSON.stringify({
          iso: new Date().toISOString(),
          status: response.status(),
          method: response.request().method(),
          url,
          body: body.slice(0, 120000)
        }) + '\n'
      );
    } catch (err) {
      // 响应体可能已被丢弃，忽略。
    }
  });

  await injectFrame(page.mainFrame());
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) await injectFrame(frame);
  }
}

async function pump(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      let drained = null;
      try {
        drained = await frame.evaluate(
          'window.__codexRec && window.__codexRec.drain ? window.__codexRec.drain() : null'
        );
      } catch (err) {
        continue;
      }
      if (drained === null) {
        await injectFrame(frame);
        continue;
      }
      for (const ev of drained) {
        const row = record(ev, page, frame);
        if (ev.kind === 'click') scheduleShot(page, row);
      }
    }
  }
}

function buildSteps() {
  const file = path.join(OUT_DIR, 'events.jsonl');
  if (!fs.existsSync(file)) return;
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);

  const out = [];
  out.push('# 录制流程');
  out.push('');
  out.push('- 输出目录：`' + OUT_DIR + '`');
  out.push('- 事件数：' + lines.length + '（点击 ' + counters.clicks + '，输入 ' + counters.inputs + '）');
  out.push('- 截图：' + shotCount + ' 张，见 `shots/`');
  out.push('');
  out.push('| # | 动作 | 目标 | 取值 | 页面 | 截图 |');
  out.push('|---|---|---|---|---|---|');

  for (const row of lines) {
    const target = row.target || row.closestActionable || {};
    const sel = target.css || '';
    const label = [
      target.text ? '"' + String(target.text).slice(0, 40) + '"' : '',
      target.tag ? target.tag : ''
    ]
      .filter(Boolean)
      .join(' ');
    const value =
      row.kind === 'input' || row.kind === 'change'
        ? String(row.value || '').slice(0, 80)
        : row.kind === 'nav'
        ? row.url
        : row.kind === 'paste'
        ? String(row.pastedText || '').slice(0, 60)
        : row.kind === 'download'
        ? row.suggestedFilename
        : row.kind === 'key'
        ? (row.ctrl ? 'Ctrl+' : '') + row.key
        : '';
    out.push(
      '| ' +
        row.seq +
        ' | ' +
        row.kind +
        ' | ' +
        (sel ? '`' + sel + '` ' : '') +
        label.replace(/\|/g, '/') +
        ' | ' +
        String(value).replace(/\|/g, '/').replace(/\n/g, ' ') +
        ' | ' +
        String(row.pageUrl || '').replace(/^https?:\/\//, '').slice(0, 50) +
        ' | ' +
        (row.kind === 'click' ? 'shots/' + String(row.seq).padStart(6, '0') + '.jpg' : '') +
        ' |'
    );
  }

  fs.writeFileSync(path.join(OUT_DIR, 'steps.md'), out.join('\n'), 'utf8');
}

async function main() {
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.connectOverCDP(ENDPOINT);
  } catch (err) {
    console.error(
      '无法连接 CDP（' +
        ENDPOINT +
        '）。Chrome 必须带 --remote-debugging-port 运行。\n原因：' +
        String(err.message).split('\n')[0]
    );
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('CDP 已连接，但没有浏览器上下文。');
    process.exit(1);
  }

  try {
    await context.addInitScript({ content: INJECT_SRC });
  } catch (err) {
    console.error('注入初始化脚本失败：' + String(err.message).split('\n')[0]);
  }

  for (const page of context.pages()) await attachPage(page);
  context.on('page', (page) => {
    attachPage(page).catch(() => {});
  });

  console.log('开始录制。输出目录：' + OUT_DIR);
  console.log('现在请在已接管的 Chrome 窗口里正常操作，Ctrl+C 结束并生成 steps.md。');

  const pumpTimer = setInterval(() => {
    if (!stopping && fs.existsSync(STOP_FILE)) {
      shutdown('STOP 文件');
      return;
    }
    pump(context).catch(() => {});
  }, POLL_MS);

  const beat = setInterval(() => {
    console.log(
      '· 已录制事件 ' +
        counters.events +
        '（点击 ' +
        counters.clicks +
        ' / 输入 ' +
        counters.inputs +
        ' / 跳转 ' +
        counters.navs +
        '）'
    );
  }, 60000);

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(pumpTimer);
    clearInterval(beat);
    console.log('\n收到 ' + signal + '，正在落盘…');
    pump(context)
      .catch(() => {})
      .then(() => {
        buildSteps();
        eventsStream.end();
        networkStream.end();
        console.log(
          '录制结束：事件 ' +
            counters.events +
            ' 条，截图 ' +
            shotCount +
            ' 张。\n' +
            '  ' + path.join(OUT_DIR, 'steps.md') + '\n' +
            '  ' + path.join(OUT_DIR, 'events.jsonl') + '\n' +
            '  ' + path.join(OUT_DIR, 'network.jsonl')
        );
        setTimeout(() => process.exit(0), 300);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('录制失败：' + err.message);
  process.exit(1);
});
