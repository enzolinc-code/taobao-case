#!/usr/bin/env node
'use strict';

// 检查：playwright 是否可用、Chrome 是否带调试端口在跑、登录态大概还在不在。
// 连不上时打印可直接粘贴的 Chrome 启动命令。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_ENDPOINT, loadPlaywright, connect, isLoginUrl } = require('./lib/browser');

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function launchHint() {
  const exe = findBrowser() || '<你的浏览器路径>';
  const profile = path.join(os.homedir(), 'taobao-automation-profile');
  return [
    '请先启动一个带调试端口的浏览器（PowerShell 复制整段执行）：',
    '',
    '  & "' + exe + '" `',
    '    --remote-debugging-port=9222 `',
    '    --user-data-dir="' + profile + '"',
    '',
    '在这个窗口里手动登录卖家中心一次，然后保持窗口开着，再重跑本脚本。',
  ].join('\n');
}

async function probeEndpoint() {
  const res = await fetch(DEFAULT_ENDPOINT + '/json/version', {
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

async function main() {
  const lines = [];
  lines.push('CDP 端点: ' + DEFAULT_ENDPOINT);
  lines.push('Node: ' + process.version);

  try {
    loadPlaywright();
    lines.push('playwright: 可用');
  } catch (err) {
    lines.push('playwright: 不可用');
    console.error(lines.join('\n'));
    console.error('\n' + err.message);
    process.exit(1);
  }

  let version;
  try {
    version = await probeEndpoint();
  } catch (err) {
    lines.push('浏览器: 未检测到调试端口');
    console.error(lines.join('\n'));
    console.error('\n' + launchHint());
    process.exit(1);
  }

  lines.push('浏览器: ' + (version.Browser || '未知'));

  const { context } = await connect();
  const pages = context.pages();
  lines.push('已打开标签页: ' + pages.length);
  for (const page of pages) {
    lines.push('  - ' + page.url());
  }

  const sellerPages = pages.filter(
    (p) => /taobao|tmall/i.test(p.url()) && !isLoginUrl(p.url())
  );
  if (pages.some((p) => isLoginUrl(p.url()))) {
    lines.push('登录态: 检测到登录页，需要真人在该窗口扫码登录');
  } else if (sellerPages.length) {
    lines.push('登录态: 检测到卖家相关页面（以发布页实测为准）');
  } else {
    lines.push('登录态: 未检测到淘宝/天猫页面，首次使用请先手动打开卖家中心并登录');
  }

  console.log(lines.join('\n'));
  // 不调用 browser.close()：那会关闭用户正在使用的浏览器。
  process.exit(0);
}

main().catch((err) => {
  console.error('环境检查失败: ' + err.message);
  process.exit(1);
});
