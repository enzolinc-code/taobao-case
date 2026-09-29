#!/usr/bin/env node
'use strict';

// 一条命令上架：按 config/ 生成配置 → 调批量脚本上架。
//
// 用法:
//   node bin/new.js 6            # 上架接下来 6 条（按编号从小到大）
//   node bin/new.js 6 --dry      # 只生成配置、打印计划，不真的上架
//   node bin/new.js --numbers 630 631 632   # 指定编号（必须已有对应素材）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'taobao-phonecase-listing', 'scripts');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const weight = (s) => Array.from(String(s)).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const GENERATE_ONLY = args.includes('--generate-only');
const numIdx = args.indexOf('--numbers');
const explicit = numIdx >= 0 ? args.slice(numIdx + 1).filter((a) => /^\d+$/.test(a)) : [];
const count = explicit.length ? explicit.length : Number(args.find((a) => /^\d+$/.test(a)) || 6);

function scan() {
  const shop = readJson(path.join(ROOT, 'config', 'shop.json'));
  const designs = [];
  for (const root of shop.paths.assetsRoots) {
    const dir = path.resolve(ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (['_listing-work', 'node_modules', 'research', '_backups', 'bin', 'config', 'docs', 'taobao-phonecase-listing', '示例-手机壳'].includes(e.name)) continue;
      if (e.name.startsWith('商品-手机壳-') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const imgs = fs.readdirSync(full).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (!imgs.length) continue;
      // assetsDir 是相对「配置所在目录（商品-手机壳-XXX）」的
      const rel = path.relative(path.join(ROOT, '商品-手机壳-x'), full).split(path.sep).join('/');
      designs.push({ name: e.name, dir: full, assetsDir: rel });
    }
  }
  return { shop, designs };
}

function ledger() {
  const shop = readJson(path.join(ROOT, 'config', 'shop.json'));
  const p = path.join(ROOT, shop.paths.ledger);
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const listed = new Set();
  let maxNo = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*\*{0,2}(\d{9,})\*{0,2}\s*\|\s*([^|]+?)\s*\|/);
    if (m) {
      listed.add(m[3].trim());
      maxNo = Math.max(maxNo, Number(m[1]));
    }
  }
  return { listed, maxNo };
}

function buildItem(shop, no, design) {
  return {
    catId: shop.catId,
    titleSuffix: shop.titleSuffix,
    titleGuardMode: shop.titleRule.guardMode,
    assetsDir: design.assetsDir,
    price: shop.price,
    stock: shop.stock,
    outerId: shop.outerId + '-' + no,
    outerIdPattern: shop.outerIdPattern,
    attributes: shop.attributes,
    axes: shop.axes,
    logistics: shop.logistics,
    notes: design.name,
  };
}

function main() {
  const { shop, designs } = scan();
  const { listed, maxNo } = ledger();

  let targets;
  if (explicit.length) {
    targets = explicit.map((no) => {
      const cfgPath = path.join(ROOT, shop.paths.itemDirPrefix + no, 'item.json');
      if (!fs.existsSync(cfgPath)) {
        console.error('编号 ' + no + ' 没有配置：' + cfgPath);
        process.exit(1);
      }
      const cfg = readJson(cfgPath);
      return { no, design: { name: cfg.notes, assetsDir: cfg.assetsDir, dir: path.resolve(path.dirname(cfgPath), cfg.assetsDir) } };
    });
  } else {
    const pending = designs.filter((d) => !listed.has(d.name));
    if (!pending.length) {
      console.log('没有待上架素材（扫描到 ' + designs.length + ' 个目录，台账已收录 ' + listed.size + ' 个）。');
      process.exit(0);
    }
    targets = pending.slice(0, count).map((d, i) => ({ no: maxNo + 1 + i, design: d }));
  }

  console.log('计划上架 ' + targets.length + ' 条：');
  for (const t of targets) {
    const w = weight(t.design.name + shop.titleSuffix);
    if (w > shop.titleRule.maxWeight) {
      console.error('  ❌ ' + t.no + ' ' + t.design.name + '：标题权重 ' + w + ' 超限，先改素材目录名');
      process.exit(1);
    }
    console.log('  ' + t.no + '  ' + t.design.name + '   (' + t.design.assetsDir + ')');
  }

  if (DRY) {
    console.log('（--dry：只列计划，没有生成配置、没有上架）');
    process.exit(0);
  }

  // 1) 生成配置
  for (const t of targets) {
    const dir = path.join(ROOT, shop.paths.itemDirPrefix + t.no);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'item.json'), JSON.stringify(buildItem(shop, t.no, t.design), null, 2) + '\n', 'utf8');
  }
  console.log('已生成 ' + targets.length + ' 份配置。');

  if (GENERATE_ONLY) {
    console.log('（--generate-only：只生成配置，没有上架）');
    process.exit(0);
  }

  // 2) 清场 + 批量上架
  spawnSync(process.execPath, [path.join(ROOT, '_listing-work', 'restart-pipeline.js')], { stdio: 'inherit' });
  const r = spawnSync(process.execPath, [
    path.join(SKILL, 'batch-accumulate.js'),
    '--max', String(shop.batch.runMax),
    '--chunk', String(shop.batch.chunk),
    ...targets.map((t) => String(t.no)),
  ], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

main();
