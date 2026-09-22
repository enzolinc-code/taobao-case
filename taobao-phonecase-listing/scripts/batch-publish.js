#!/usr/bin/env node
'use strict';

// 批量：逐个商品走同一条流水线，串行、带随机停顿、有每日预算和断点续跑。
//
// 默认不提交。要提交必须显式加 --submit；批量提交还要再加 --i-know。
// 命中风控信号立即中断整批，并把剩下没跑的标成 not-started。

const fs = require('fs');
const path = require('path');
const { getArg, ensureDir, writeJson, readJson, sleep } = require('./lib/browser');
const { runFill, findSelectors } = require('./lib/fill-core');

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveItems(entries) {
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      const target = path.resolve(entry);
      const itemPath = fs.existsSync(target) && fs.statSync(target).isDirectory()
        ? path.join(target, 'item.json')
        : target;
      return { label: path.basename(path.dirname(itemPath)) || entry, itemPath };
    }
    const dir = entry.dir || entry.folder;
    const itemPath = entry.item || (dir ? path.join(path.resolve(dir), 'item.json') : null);
    return { label: entry.label || entry.title || (dir ? path.basename(path.resolve(dir)) : itemPath), itemPath };
  });
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendLedger(file, entry) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

function randomPause(minMs, maxMs) {
  const min = Math.max(0, minMs);
  const max = Math.max(min + 1, maxMs);
  return min + Math.floor(Math.random() * (max - min));
}

async function main() {
  const itemsArg = parseList(getArg('items'));
  const batchArg = getArg('batch');
  if (!itemsArg.length && !batchArg) {
    console.error('用法: node batch-publish.js --items 文件夹A,文件夹B [--submit --i-know]');
    console.error('   或: node batch-publish.js --batch batch.json [--submit --i-know]');
    console.error('batch.json 可以是 ["路径", …] 或 [{"dir": "路径"}, …]');
    process.exit(1);
  }

  const rawEntries = batchArg ? readJson(path.resolve(batchArg)) : itemsArg;
  const items = resolveItems(Array.isArray(rawEntries) ? rawEntries : []);
  if (!items.length) {
    console.error('没有解析到任何商品。检查 --items 或 batch.json 的内容。');
    process.exit(1);
  }

  const outRoot = path.resolve(getArg('out') || path.join(process.cwd(), '_listing-work'));
  const ledgerFile = path.join(outRoot, 'ledger.jsonl');
  const selectorsPath = getArg('selectors');
  const runDir = path.join(outRoot, 'batch-' + new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(runDir);

  const submit = process.argv.includes('--submit');
  const iKnow = process.argv.includes('--i-know');
  const force = process.argv.includes('--force');
  if (submit && !iKnow) {
    console.error('批量提交要把 --submit 和 --i-know 一起写。这是刻意加的摩擦：先确认这批商品的标题、价格、SKU 都核对过。');
    process.exit(1);
  }

  const perDay = Number(getArg('per-day') || process.env.TAOBAO_DAILY_LIMIT || 10);
  const pauseMin = Number(getArg('pause-min') || process.env.TAOBAO_BATCH_PAUSE_MIN_MS || 20000);
  const pauseMax = Number(getArg('pause-max') || process.env.TAOBAO_BATCH_PAUSE_MAX_MS || 60000);
  const maxConsecutiveFailures = Number(getArg('max-failures') || 3);
  const ignoreBudget = process.argv.includes('--ignore-budget');

  const today = new Date().toISOString().slice(0, 10);
  const ledger = readLedger(ledgerFile);
  const doneToday = ledger.filter(
    (e) => e.date === today && ['ok', 'partial'].includes(e.status)
  ).length;

  const finished = new Set(
    ledger.filter((e) => e.status === 'ok' && (e.submitted || !submit)).map((e) => path.resolve(e.itemPath))
  );

  let queue = items.filter((item) => force || !finished.has(path.resolve(item.itemPath)));
  const skipped = items.length - queue.length;

  if (!ignoreBudget) {
    const left = Math.max(0, perDay - doneToday);
    if (queue.length > left) {
      console.log('今日预算 ' + perDay + ' 个，已用 ' + doneToday + ' 个，本次只跑前 ' + left + ' 个。');
      console.log('要超预算跑就加 --ignore-budget，但先想清楚风控代价。');
      queue = queue.slice(0, left);
    }
  }

  console.log('待跑: ' + queue.length + ' / 共 ' + items.length + (skipped ? '（跳过已完成 ' + skipped + '）' : ''));
  console.log('提交模式: ' + (submit ? '开启' : '关闭（只填不提交）'));
  console.log('账本: ' + ledgerFile);
  console.log('');

  if (!queue.length) {
    console.log('没有要跑的商品。');
    process.exit(0);
  }

  const results = [];
  let consecutiveFailures = 0;
  let stopped = null;

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    process.stdout.write('[' + (i + 1) + '/' + queue.length + '] ' + entry.label + ' … ');

    let result;
    try {
      result = await runFill({
        itemPath: entry.itemPath,
        selectorsPath,
        outRoot: runDir,
        options: { submit, force },
      });
    } catch (err) {
      result = {
        status: 'error',
        reason: String(err.message || err).split('\n')[0],
        preflight: { blockers: [], warnings: [] },
        report: [],
        errorMarkers: [],
        riskSignals: [],
        skuSummary: null,
      };
    }

    const record = {
      date: today,
      time: new Date().toISOString(),
      label: entry.label,
      itemPath: path.resolve(entry.itemPath),
      catId: result.catId || null,
      title: result.title || '',
      status: result.status,
      reason: result.reason || '',
      skuRows: result.skuSummary ? result.skuSummary.rows : null,
      blocked: (result.preflight && result.preflight.blockers) || [],
      failedRules: (result.report || []).filter((r) => r.status === 'failed').map((r) => r.key + ': ' + r.detail),
      errorMarkers: result.errorMarkers || [],
      riskSignals: result.riskSignals || [],
      submitted: Boolean(result.submitted),
      submit: result.submit || null,
      screenshot: result.screenshot || null,
      outDir: result.outDir || null,
    };
    appendLedger(ledgerFile, record);
    results.push(record);

    console.log(
      record.status +
        (record.reason ? ' — ' + record.reason : '') +
        (record.skuRows ? '（SKU ' + record.skuRows + ' 行）' : '') +
        (record.riskSignals.length ? '（风控: ' + record.riskSignals.map((s) => s.id).join(',') + '）' : '')
    );
    for (const blocker of record.blocked.slice(0, 3)) console.log('      拦截: ' + blocker);
    for (const failure of record.failedRules.slice(0, 3)) console.log('      失败: ' + failure);

    if (result.status === 'blocked' || result.status === 'login-required') {
      stopped = result.status;
      const rest = queue.slice(i + 1).map((item) => ({
        date: today,
        time: new Date().toISOString(),
        label: item.label,
        itemPath: path.resolve(item.itemPath),
        status: 'not-started',
        reason: '前一个商品触发 ' + result.status + '，整批中止',
      }));
      for (const item of rest) appendLedger(ledgerFile, item);
      console.log('');
      console.log('已中止整批：' + record.reason + '。剩下 ' + rest.length + ' 个标记为 not-started。');
      break;
    }

    if (result.status === 'ok') consecutiveFailures = 0;
    else consecutiveFailures++;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      stopped = 'too-many-failures';
      console.log('');
      console.log('连续 ' + consecutiveFailures + ' 个没跑通，停止整批。先修 selectors.json 再继续。');
      break;
    }

    if (i < queue.length - 1) {
      const wait = randomPause(pauseMin, pauseMax);
      console.log('      等待 ' + Math.round(wait / 1000) + ' 秒后继续');
      await sleep(wait);
    }
  }

  const summary = {
    date: today,
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    partial: results.filter((r) => r.status === 'partial').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    loginRequired: results.filter((r) => r.status === 'login-required').length,
    error: results.filter((r) => r.status === 'error').length,
    submitted: results.filter((r) => r.submitted).length,
    stopped,
  };
  writeJson(path.join(runDir, 'batch-summary.json'), { summary, results });

  console.log('');
  console.log('本批小结: ' + JSON.stringify(summary));
  console.log('账本: ' + ledgerFile);
  console.log('本批报告: ' + path.join(runDir, 'batch-summary.json'));

  process.exit(stopped === 'blocked' || stopped === 'login-required' ? 2 : summary.error + summary.partial > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('批量失败: ' + err.message);
  process.exit(1);
});
