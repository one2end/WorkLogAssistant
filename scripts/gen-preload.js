#!/usr/bin/env node
'use strict';

/**
 * 从 electron/ipcRegistry.js 生成三个 preload 文件。
 *
 * 为什么要有这个脚本，而不是手写三个文件：
 *   手写 75 个方法一定会漏，而漏掉的表现是「某个功能在关闭隔离之后
 *   突然失灵」，报错信息是 `xxx is not a function`，与真正的原因
 *   （preload 少了一个方法）隔了好几层。
 *
 *   注册表是权限矩阵的唯一事实源。让 preload 从它生成，
 *   「文档里写了什么」「代码里暴露了什么」就只有一份。
 *
 * 用法：node scripts/gen-preload.js
 *      node scripts/gen-preload.js --check   # 只校验是否同步，不写文件
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const reg = require(path.join(ROOT, 'electron/ipcRegistry.js'));

const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

const ROLES = [
  {
    role: 'main',
    file: 'electron/preload.js',
    title: '主窗口 preload',
    why: '主窗拥有全部能力，因为它是唯一能修改数据的界面。\n * 但它同样不使用通用 invoke(channel, ...)：暴露面就是白名单本身。',
    extra: `
  /**
   * 复制一段文本到剪贴板。
   *
   * 为什么不暴露整个 electron.clipboard：那个模块包含**读**能力，
   * 而这里只需要写。能给一个参数就不要给一个模块。
   */
  writeClipboard: (text) => {
    if (typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  },

  /**
   * 请求主进程打开外部链接。
   *
   * 渲染层不直接调 shell.openExternal —— 那等于把「可以打开任意协议」
   * 的能力交给渲染层。这里只递交 URL，是否放行由主进程按白名单判断（B2）。
   */
  openExternal: (...args) => invoke('open-external', ...args)`
  },
  {
    role: 'focus',
    file: 'electron/preload-focus.js',
    title: '专注窗口 preload',
    why: '专注窗只需要控制专注会话、订阅专注状态。它不该能读写活动记录、\n * 改配置或迁移数据——一个只负责倒计时的窗口没有理由拥有这些能力。',
    extra: ''
  },
  {
    role: 'float',
    file: 'electron/preload-float.js',
    title: '悬浮条 preload',
    why: '悬浮条只做三件事：显示状态、拖动自己、开关录制。它拿不到活动数据，\n * 也改不了配置——这正是「最小能力」的意思。',
    extra: ''
  }
];

function generate(spec) {
  // 跳过手写通道：它们在 preload 里以收窄的能力形式出现（见 HAND_WIRED），
  // 自动生成会多出一个同名方法。
  const ch = reg.channelsForRole(spec.role).filter(c => !reg.HAND_WIRED.has(c));
  const ev = reg.eventsForRole(spec.role);
  const methods = ch
    .map(c => `  ${camel(c)}: (...args) => invoke('${c}', ...args),`)
    .join('\n');
  const events = ev.map(e => `    '${e}'`).join(',\n');
  const electronImports = spec.role === 'main'
    ? 'contextBridge, ipcRenderer, clipboard'
    : 'contextBridge, ipcRenderer';

  return `'use strict';

/**
 * ${path.basename(spec.file)} — ${spec.title}
 *
 * 由 scripts/gen-preload.js 从 electron/ipcRegistry.js 生成，请勿手改。
 * 要加通道，改注册表，再重新生成本文件。
 *
 * 为什么不用一个通用的 invoke(channel, ...)：
 *   那等于把「能调哪些通道」交给渲染层决定，隔离就白做了。
 *   这里每个通道一个具名方法，暴露面就是白名单本身。
 *
 * 为什么按角色分文件而不是运行时判断：
 *   角色推断错一次就是权限错配，而这种错误不会报错，
 *   只会让某个窗口悄悄多出不该有的能力。
 *
 * ${spec.why}
 */

const { ${electronImports} } = require('electron');

// 透传全部参数：少数通道是多参数的（focus-add-note 的 (text, category)、
// set-float-pos 的 (x, y)）。只转发一个 payload 会让它们静默收不到第二个参数。
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 允许订阅的事件（主进程推送）。不在表内的事件不允许监听。 */
const EVENTS = new Set([
${events}
]);

contextBridge.exposeInMainWorld('worklog', {
${methods}

  /**
   * 订阅主进程推送。返回取消订阅函数；调用方应在卸载时调用它，
   * 否则重复打开窗口会累积监听器。
   */
  on: (eventName, handler) => {
    if (!EVENTS.has(eventName)) {
      throw new Error('不允许订阅该事件: ' + eventName);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  },${spec.extra}
});
`;
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;

  for (const spec of ROLES) {
    const target = path.join(ROOT, spec.file);
    const next = generate(spec);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

    if (current === next) {
      console.log(`同步 ${spec.file}`);
      continue;
    }

    if (check) {
      console.error(`不同步 ${spec.file}（注册表改了但没重新生成）`);
      stale += 1;
      continue;
    }

    fs.writeFileSync(target, next, 'utf8');
    console.log(`已生成 ${spec.file}（${reg.channelsForRole(spec.role).length} 个通道）`);
  }

  if (stale > 0) process.exit(1);
}

main();
