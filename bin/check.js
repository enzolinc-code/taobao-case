#!/usr/bin/env node
'use strict';

// 部署自检：一次把「配置 / 素材命名 / 标题长度 / 机型规格 / 待上架」全查一遍，
// **不碰线上、不改任何文件**（`--fix` 只做无风险的同步，比如把 config/models.json 覆盖回机型清单.json）。
//
// 用法:
//   node bin/check.js            # 全量自检
//   node bin/check.js --fix      # 顺带把 机型清单.json 同步成 config/models.json 的内容

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIX = process.argv.includes('--fix');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const weight = (s) => Array.from(String(s)).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.log('  ❌ ' + msg); };
const warn = (msg) => { warnings++; console.log('  ⚠️ ' + msg); };
const ok = (msg) => console.log('  ✅ ' + msg);

function loadConfig() {
  console.log('── 1. 配置 ────────────────────────────────');
  const need = ['config/shop.json', 'config/models.json', 'config/image-spec.json'];
  for (const f of need) {
    if (!fs.existsSync(path.join(ROOT, f))) err('缺配置文件 ' + f);
  }
  if (errors) return null;
  const shop = readJson(path.join(ROOT, 'config/shop.json'));
  const models = readJson(path.join(ROOT, 'config/models.json'));
  const spec = readJson(path.join(ROOT, 'config/image-spec.json'));

  ok('模板商品ID（copyFromItemId）: ' + shop.copyFromItemId);
  ok('标题后缀: ' + shop.titleSuffix + '（权重 ' + weight(shop.titleSuffix) + '）');
  ok('类目 catId: ' + shop.catId);

  const m = models.axes && models.axes['适用手机型号'];
  const c = models.axes && models.axes['颜色分类'];
  if (!Array.isArray(m) || !m.length) err('config/models.json 里「适用手机型号」为空');
  if (!Array.isArray(c) || !c.length) err('config/models.json 里「颜色分类」为空');
  if (Array.isArray(m) && Array.isArray(c)) {
    ok('SKU 规格: ' + m.length + ' 机型 × ' + c.length + ' 颜色 = ' + m.length * c.length + ' 行');
    if (c.length !== spec.sku.count) {
      err('颜色数(' + c.length + ') 与 image-spec 里的 SKU 图数量(' + spec.sku.count + ') 不一致');
    }
  }

  // 老位置兼容副本
  const legacy = path.join(ROOT, '机型清单.json');
  if (fs.existsSync(legacy)) {
    const same = JSON.stringify(readJson(legacy)) === JSON.stringify(models);
    if (!same) {
      if (FIX) {
        fs.copyFileSync(path.join(ROOT, 'config/models.json'), legacy);
        ok('机型清单.json 与 config/models.json 不一致，已按 --fix 同步');
      } else {
        warn('机型清单.json 与 config/models.json 不一致（脚本实际优先用 config/models.json；要同步就加 --fix）');
      }
    } else {
      ok('机型清单.json 与 config/models.json 一致');
    }
  }

  return { shop, models, spec };
}

function scanDesigns(cfg) {
  console.log('');
  console.log('── 2. 素材目录与命名 ──────────────────────');
  const designs = [];
  for (const root of cfg.shop.paths.assetsRoots) {
    const dir = path.resolve(ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['_listing-work', 'node_modules', 'research', '_backups', 'bin', 'config', 'docs', 'taobao-phonecase-listing', '示例-手机壳'].includes(entry.name)) continue;
      if (entry.name.startsWith('商品-手机壳-') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const files = fs.readdirSync(full);
      const imgs = files.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (!imgs.length) continue;
      designs.push({ name: entry.name, dir: full, files, imgs, root });
    }
  }

  const problems = [];
  for (const d of designs) {
    const counts = {};
    for (const key of ['main1x1', 'main3x4', 'sku', 'detail']) {
      const rule = cfg.spec[key];
      const hit = d.imgs.filter((f) => new RegExp(rule.pattern, 'i').test(f));
      counts[key] = hit.length;
      if (hit.length !== rule.count) {
        problems.push(d.name + '：' + rule.title + ' 应有 ' + rule.count + ' 张，实际 ' + hit.length + ' 张');
      }
    }
    const skip = d.imgs.filter((f) => new RegExp(cfg.spec.skip.pattern).test(f)).length;
    const usable = counts.main1x1 + counts.main3x4 + counts.sku + counts.detail;
    if (usable !== cfg.spec.totalUsable) {
      problems.push(d.name + '：可用图合计 ' + usable + ' 张，应为 ' + cfg.spec.totalUsable);
    }
    // 标题长度
    const w = weight(d.name + cfg.shop.titleSuffix);
    if (w > cfg.shop.titleRule.maxWeight) {
      problems.push(d.name + '：标题权重 ' + w + '/' + cfg.shop.titleRule.maxWeight +
        '（后缀占 ' + weight(cfg.shop.titleSuffix) + '，目录名只能占 ' + cfg.shop.titleRule.designNameMaxWeight + ' 权重；汉字按 2 计）');
    }
    d.counts = counts;
    d.skip = skip;
  }

  if (problems.length) {
    for (const p of problems) err(p);
  } else {
    ok(designs.length + ' 个素材目录，命名与数量全部合规');
  }
  return designs;
}

function listPending(cfg, designs) {
  console.log('');
  console.log('── 3. 待上架 ──────────────────────────────');
  const ledgerPath = path.join(ROOT, cfg.shop.paths.ledger);
  const ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const listed = new Set();
  let maxNo = 0;
  for (const line of ledger.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*\*{0,2}(\d{9,})\*{0,2}\s*\|\s*([^|]+?)\s*\|/);
    if (m) {
      listed.add(m[3].trim());
      maxNo = Math.max(maxNo, Number(m[1]));
    }
  }
  const pending = designs.filter((d) => !listed.has(d.name));
  ok('台账已收录设计 ' + listed.size + ' 个，最大编号 ' + maxNo);
  if (!pending.length) {
    ok('没有待上架素材');
  } else {
    ok('待上架 ' + pending.length + ' 条：');
    pending.forEach((d, i) => console.log('     ' + (maxNo + 1 + i) + '. ' + d.name + '（' + d.dir.replace(ROOT + path.sep, '') + '）'));
  }
  return pending;
}

function main() {
  const cfg = loadConfig();
  if (!cfg) {
    console.log('');
    console.log('配置不全，先补齐 config/ 再跑。');
    process.exit(1);
  }
  const designs = scanDesigns(cfg);
  listPending(cfg, designs);

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  素材目录 ' + designs.length + ' 个 | 错误 ' + errors + ' | 警告 ' + warnings);
  console.log(errors ? '  ❌ 自检未通过，先修上面的错误再上架。' : '  ✅ 自检通过，可以上架（node bin/new.js 6）。');
  process.exit(errors ? 1 : 0);
}

main();
