'use strict';

// 依据淘宝《3C数码配件发布规范》：手机壳、手机膜、充电宝等叶子类目"可以出现品牌词，
// 但必须带'适用于'"，且标题、导购标题、图片里的品牌词都要加适用词、字号不小于 50%。
// 规范原文：https://qn.taobao.com/headline/news/10701499/
//
// 这个模块只校验文字。图片里的字脚本看不见，属于人工检查项（见 references/publish-fields.md）。

const BRAND_TOKENS = [
  '苹果', 'Apple', 'iPhone', 'iPad',
  '华为', '荣耀',
  '小米', 'MIUI', '米家', '红米', 'Redmi',
  'OPPO', 'vivo', '一加', 'OnePlus', 'realme', '真我',
  '三星', 'Samsung', '魅族', '努比亚', '摩托罗拉', '诺基亚', '索尼', 'Sony',
];

const APPLICABLE_TOKENS = ['适用', '支持', '专用', '用于', '可用', 'applicable', 'made for'];

// "苹果绿""苹果色"是颜色词，不是品牌指代。
const FALSE_POSITIVE_SUFFIXES = ['绿', '色'];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasApplicablePrefix(title, token) {
  const pattern = new RegExp(
    '(?:' + APPLICABLE_TOKENS.map(escapeRegExp).join('|') + ')\\s*[于]?\\s*' + escapeRegExp(token),
    'i'
  );
  return pattern.test(String(title));
}

function findBrands(text) {
  const source = String(text || '');
  const hits = [];
  for (const token of BRAND_TOKENS) {
    const re = new RegExp(escapeRegExp(token) + '(?![' + FALSE_POSITIVE_SUFFIXES.join('') + '])', 'gi');
    const matched = source.match(re);
    if (matched) hits.push({ token, count: matched.length });
  }
  return hits;
}

// 按字符数（一个汉字 = 1），不是 UTF-8 字节数。
function charLength(text) {
  return Array.from(String(text || '')).length;
}

function checkTitle(title, options = {}) {
  const text = String(title || '');
  const maxChars = Number(options.maxChars || 60);
  const issues = [];
  const warnings = [];

  if (!text.trim()) issues.push('标题为空');

  const length = charLength(text);
  if (length > maxChars) {
    issues.push('标题 ' + length + ' 字符，超过配置上限 ' + maxChars + '（上限以 probe 实测为准）');
  }

  const brands = findBrands(text);
  for (const { token } of brands) {
    if (!hasApplicablePrefix(text, token)) {
      issues.push(
        '品牌词「' + token + '」前面没有"适用于/支持/专用"这类适用词。' +
          '3C 数码配件规范对这类写法是下架、删除、扣分，不能批量提交。'
      );
    }
  }
  if (!brands.length) {
    warnings.push('标题里没有品牌词：适配款手机壳的买家通常按机型搜索，没有品牌词可能没有流量（不是错误）');
  }

  return { ok: issues.length === 0, issues, warnings, length, brands };
}

// 只做"把裸品牌词补上适用词"这一件事，输出给人工确认，或由 --fix-title 显式启用。
function suggestFix(title) {
  let text = String(title || '');
  for (const { token } of findBrands(text)) {
    if (hasApplicablePrefix(text, token)) continue;
    const pattern = new RegExp(
      '(^|[^\\u4e00-\\u9fa5A-Za-z])(' + escapeRegExp(token) + ')',
      'g'
    );
    text = text.replace(pattern, (match, prefix, hit) => prefix + '适用于' + hit);
  }
  return text;
}

module.exports = {
  checkTitle,
  suggestFix,
  findBrands,
  charLength,
  BRAND_TOKENS,
  APPLICABLE_TOKENS,
};
