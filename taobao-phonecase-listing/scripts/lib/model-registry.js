'use strict';

// 全店共用一份机型表：几百个 item.json 引用它，而不是各自抄一遍机型列表。
// 改机型（新增 iPhone 17、下架某型号）只需要动这一个文件。
//
// 只做解析和筛选，不碰页面。

const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_NAME = '机型清单.json';
const MAX_UPWARD_LEVELS = 5;

// 裸文件名往上找：机型清单.json 放项目根，商品文件夹在它下面就能自动找到。
function resolveRegistryPath(file, startDir) {
  if (path.isAbsolute(file)) return file;
  const base = startDir || process.cwd();
  if (file.includes('/') || file.includes('\\')) {
    // 【2026-09-29】带路径的写法（如 "config/models.json"）：
    // 先按「相对当前商品目录」解析，找不到就逐级往上找 —— 这样配置文件里
    // 可以写仓库根相对的路径，商品目录在下面任意一层都能找到。
    const direct = path.resolve(base, file);
    if (fs.existsSync(direct)) return direct;
    let up = base;
    for (let level = 0; level < MAX_UPWARD_LEVELS; level++) {
      const candidate = path.join(up, file);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(up);
      if (parent === up) break;
      up = parent;
    }
    return direct;
  }

  let dir = base;
  for (let level = 0; level < MAX_UPWARD_LEVELS; level++) {
    // 【2026-09-29】部署化改造：机型规格现在有规范位置 config/models.json。
    // 当调用方按默认名（机型清单.json）找表时，优先用 config/models.json；
    // 没有才回落到老位置，保证老配置继续能跑。
    if (file === DEFAULT_REGISTRY_NAME) {
      const preferred = path.join(dir, 'config', 'models.json');
      if (fs.existsSync(preferred)) return preferred;
    }
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(base, file);
}

function loadRegistry(file, baseDir) {
  const resolved = resolveRegistryPath(file, baseDir);
  const issues = [];

  if (!fs.existsSync(resolved)) {
    return { path: resolved, axes: {}, issues: ['找不到机型清单: ' + resolved] };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    return {
      path: resolved,
      axes: {},
      issues: ['机型清单不是合法 JSON: ' + String(err.message || err).split('\n')[0]],
    };
  }

  const source = raw.axes && typeof raw.axes === 'object' ? raw.axes : {};
  const axes = {};

  for (const [axisName, list] of Object.entries(source)) {
    if (!Array.isArray(list)) {
      issues.push('机型清单.' + axisName + ' 不是数组');
      continue;
    }
    const entries = [];
    const seen = new Map();

    list.forEach((raw_entry, index) => {
      const entry = typeof raw_entry === 'string' ? { name: raw_entry } : raw_entry || {};
      const name = String(entry.name || '').trim();
      if (!name) {
        issues.push('机型清单.' + axisName + ' 第 ' + (index + 1) + ' 项没有 name');
        return;
      }
      if (seen.has(name)) {
        issues.push(
          '机型清单.' + axisName + ' 有重复值「' + name + '」（第 ' + (seen.get(name) + 1) +
            ' 项与第 ' + (index + 1) + ' 项），重复值会让 SKU 行合并'
        );
        return;
      }
      seen.set(name, index);
      entries.push({ ...entry, name, enabled: entry.enabled !== false });
    });

    if (!entries.length) issues.push('机型清单.' + axisName + ' 是空的');
    axes[axisName] = entries;
  }

  if (!Object.keys(axes).length) issues.push('机型清单里没有任何 axis（应该是 axes: { "适用机型": [...] }）');
  return { path: resolved, axes, issues };
}

// only / groups 是白名单，except 是黑名单；三者都可以填名称或 group 名。
function selectEntries(entries, ref = {}) {
  let list = entries.filter((entry) => entry.enabled);

  const only = Array.isArray(ref.only) ? ref.only.map(String) : null;
  if (only) list = list.filter((e) => only.includes(e.name) || (e.group && only.includes(e.group)));

  const groups = Array.isArray(ref.groups) ? ref.groups.map(String) : null;
  if (groups) list = list.filter((e) => e.group && groups.includes(e.group));

  const except = Array.isArray(ref.except) ? ref.except.map(String) : null;
  if (except) list = list.filter((e) => !except.includes(e.name) && !(e.group && except.includes(e.group)));

  return list;
}

// 把 item.json 的 axes 解析成纯字符串数组；数组原样透传，引用对象查机型清单。
function resolveItemAxes(item, itemDir, options = {}) {
  const issues = [];
  const warnings = [];
  const axes = {};
  const entriesByAxis = {};
  const usedPaths = [];
  const cache = options.cache || new Map();
  const defaultRegistry = item.registry || options.defaultRegistry || DEFAULT_REGISTRY_NAME;

  // 显式写了 skus 的商品不需要展开轴，机型清单对它不生效。
  if (Array.isArray(item.skus) && item.skus.length) {
    return { axes, entriesByAxis, issues, warnings, skippedRegistry: true, path: null, paths: [] };
  }

  const rawAxes = item.axes && typeof item.axes === 'object' ? item.axes : {};
  if (!Object.keys(rawAxes).length) {
    return {
      axes,
      entriesByAxis,
      issues: ['item.json 里没有 axes'],
      warnings,
      skippedRegistry: false,
      path: null,
      paths: [],
    };
  }

  const load = (file) => {
    const key = resolveRegistryPath(file, itemDir);
    if (!cache.has(key)) {
      const registry = loadRegistry(file, itemDir);
      cache.set(key, registry);
      for (const issue of registry.issues) issues.push(issue);
    }
    const registry = cache.get(key);
    if (!usedPaths.includes(registry.path)) usedPaths.push(registry.path);
    return registry;
  };

  for (const [axisName, value] of Object.entries(rawAxes)) {
    if (String(axisName).startsWith('_')) continue; // 模板注释键，不是轴
    if (Array.isArray(value)) {
      axes[axisName] = value.map((v) => String(v)).filter(Boolean);
      // 数组写法是自给自足的；但如果清单里恰好也定义了同名的轴，就用它的 code 补编码。
      // 清单不存在不算错误——数组本来就不依赖清单。
      const softPath = resolveRegistryPath(defaultRegistry, itemDir);
      if (fs.existsSync(softPath)) {
        const registry = load(defaultRegistry);
        const entries = registry.axes[axisName];
        if (entries) {
          const byName = new Map(entries.map((entry) => [entry.name, entry]));
          const picked = new Map();
          for (const name of axes[axisName]) if (byName.has(name)) picked.set(name, byName.get(name));
          if (picked.size) entriesByAxis[axisName] = picked;
        }
      }
      continue;
    }
    if (!value || typeof value !== 'object') {
      issues.push('轴「' + axisName + '」既不是数组也不是引用对象（形如 { "fromRegistry": "机型清单.json" }）');
      continue;
    }

    const file = value.fromRegistry || value.registry || value.from || defaultRegistry;
    const registry = load(file);
    const sourceAxis = value.axis || axisName;
    const entries = registry.axes[sourceAxis];
    if (!entries) {
      issues.push('轴「' + axisName + '」引用的 ' + registry.path + ' 里没有「' + sourceAxis + '」');
      continue;
    }

    let picked = selectEntries(entries, value);
    if (!picked.length) {
      issues.push('轴「' + axisName + '」筛选后没有任何机型（检查 only / groups / except 或 enabled）');
      continue;
    }

    if (typeof value.limit === 'number' && value.limit > 0 && picked.length > value.limit) {
      warnings.push(
        '轴「' + axisName + '」筛选出 ' + picked.length + ' 个值，按 limit=' + value.limit + ' 截取前 ' + value.limit + ' 个'
      );
      picked = picked.slice(0, value.limit);
    }

    axes[axisName] = picked.map((entry) => entry.name);
    entriesByAxis[axisName] = new Map(picked.map((entry) => [entry.name, entry]));
  }

  for (const [axisName, list] of Object.entries(axes)) {
    if (!list.length) issues.push('轴「' + axisName + '」最终没有任何值');
  }

  return {
    axes,
    entriesByAxis,
    issues,
    warnings,
    skippedRegistry: false,
    path: usedPaths[0] || null,
    paths: usedPaths,
  };
}

// 按 item.outerIdPattern 生成 SKU 商家编码，例如 "{prefix}-{适用机型.code}-{颜色.code}"。
// 显式写了 outerId 的行不覆盖；缺 code 的行保持空白并提示。
function applyOuterIds(rows, item, entriesByAxis) {
  const pattern = item.outerIdPattern;
  const warnings = [];
  if (!pattern) return { rows, warnings };

  for (const row of rows) {
    if (row.outerIdExplicit) continue;
    let text = String(pattern).split('{prefix}').join(item.outerId || '');

    for (const [axisName, value] of Object.entries(row.axes)) {
      const entry = entriesByAxis[axisName] ? entriesByAxis[axisName].get(value) : null;
      const code = entry && entry.code ? entry.code : '';
      text = text.split('{' + axisName + '.code}').join(code);
      text = text.split('{' + axisName + '}').join(code || '');
      if (!code) warnings.push('「' + value + '」没有 code，编码里会留空：' + text);
    }

    text = text.replace(/-+$/, '').replace(/--+/g, '-');
    if (/\{[^}]+\}/.test(text)) {
      warnings.push('编码模板有没替换的占位符，已跳过：' + text);
      continue;
    }
    row.outerId = text;
    row.outerIdExplicit = true;
  }

  return { rows, warnings: [...new Set(warnings)].slice(0, 10) };
}

module.exports = {
  DEFAULT_REGISTRY_NAME,
  resolveRegistryPath,
  loadRegistry,
  selectEntries,
  resolveItemAxes,
  applyOuterIds,
};
