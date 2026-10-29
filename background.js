/**
 * Tab PiP Studio —— 后台 Service Worker
 *
 * 职责：
 *   1. 维护全局状态（storage.session 持久化，Service Worker 重启后不丢）
 *   2. 编排两种互斥的画中画模式：
 *        - hub  画中画台：扩展页里的 iframe 实时预览，可瞬间在标签页之间来回切换
 *        - dom  镜像模式：把某个标签的 DOM 整体搬进画中画窗口（任何网站可用，含禁止 iframe 嵌入的站点）
 *   3. 响应快捷键（chrome.commands）与 popup/内容脚本/控制台页的消息
 *
 * 关键 API 事实（已核实）：
 *   - documentPictureInPicture.requestWindow() 必须“瞬态用户激活”（真实点击），
 *     因此快捷键/按钮注入的路径用 scripting.executeScript({ userGesture: true }) 尽力满足，失败则提示用户直接点击。
 *   - PiP 窗口与打开者同源；打开者标签被关闭或导航时，PiP 窗口自动关闭（规范保证，无需手工清理）。
 *   - PiP 窗口内 requestFullscreen() 被规范禁用；resizeTo/resizeBy 需要 PiP 窗口内的用户手势，
 *     所以本扩展不做程序化缩放，用户可直接拖拽调整。
 */

'use strict';

const CONSOLE_URL = chrome.runtime.getURL('pip-console.html');

const DEFAULT_SETTINGS = {
  pipWidth: 960,
  pipHeight: 640,
  followByDefault: false,
};

/** 内存态与 storage.session 镜像。 */
let state = { mode: null, hub: null, dom: null };
// state.mode: null | 'hub' | 'dom'
// state.hub: { consoleTabId, consoleWindowId, follow }
// state.dom: { ownerTabId, ownerWindowId }

// ---------------------------------------------------------------------------
// 状态存取
// ---------------------------------------------------------------------------

async function loadState() {
  const got = await chrome.storage.session.get('tpip:state');
  state = got['tpip:state'] || { mode: null, hub: null, dom: null };
}

async function saveState() {
  await chrome.storage.session.set({ 'tpip:state': state });
}

async function loadSettings() {
  const got = await chrome.storage.local.get('tpip:settings');
  return { ...DEFAULT_SETTINGS, ...(got['tpip:settings'] || {}) };
}

/** 置空某模式的状态并保存。 */
function resetState() {
  state = { mode: null, hub: null, dom: null };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function getConsoleTab() {
  const tabs = await chrome.tabs.query({ url: CONSOLE_URL });
  return tabs[0] || null;
}

/** 打开（或激活）画中画控制台页。 */
async function openConsole() {
  let tab = await getConsoleTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ url: CONSOLE_URL, active: true });
  }
  return tab;
}

async function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

/** 失败时在工具栏图标上闪一个“!”，同时打印日志。 */
function flashBadge(reason) {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  console.warn('[TabPiP]', reason);
}

// ---------------------------------------------------------------------------
// 模式一：画中画台（hub）
// ---------------------------------------------------------------------------

/**
 * 启动画中画台。setTabId 可选：启动后立即在画中画中显示该标签。
 *
 * 关键点：requestWindow() 需要目标文档内的瞬态用户激活，而“快捷键/点 popup”并不会把
 * 激活带给控制台页。因此这里用 scripting.executeScript 的 userGesture:true 注入到
 * 控制台页的 MAIN world（扩展页的页面脚本运行在主 world），尽力模拟用户手势。
 * 若仍被浏览器拒绝（个别版本对注入手势判定不同），控制台页会显示提示，用户点一下按钮即可。
 */
async function startHub({ setTabId } = {}) {
  // 互斥：hub 与 dom 只能存在一个
  if (state.mode === 'dom') {
    await closeDom();
  }

  const consoleTab = await openConsole();

  // 轮询等待控制台页脚本就绪，然后注入“自动启动”
  let injected = false;
  for (let i = 0; i < 12; i++) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: consoleTab.id },
        world: 'MAIN', // 控制台页是扩展页，页面脚本跑在 MAIN world
        userGesture: true,
        func: (payload) => {
          const api = window.__pipConsole;
          if (!api) return { ok: false, reason: 'console-not-ready' };
          return api.autoStart(payload.setTabId ?? null);
        },
        args: [{ setTabId: setTabId ?? null }],
      });
      const r = res && res[0] && res[0].result;
      if (r && r.ok) { injected = true; break; }
      if (r && r.reason && r.reason !== 'console-not-ready') break;
    } catch (e) {
      // 页面还没加载完等下一次；注入被禁止（极少数内建页）则放弃
      console.warn('[TabPiP] startHub inject failed:', String(e));
    }
    await wait(250);
  }

  if (!injected) {
    flashBadge('画中画台启动失败：请在控制台页中直接点击“启动画中画窗口”按钮（需要一次真实点击手势）。');
    return { ok: false, reason: 'activation-required' };
  }
  return { ok: true };
}

async function closeHub() {
  if (state.mode === 'hub' && state.hub) {
    try {
      await sendToTab(state.hub.consoleTabId, { type: 'tpip-hub-close' });
    } catch { /* 控制台页已不在，忽略 */ }
  }
  resetState();
  await saveState();
}

// ---------------------------------------------------------------------------
// 模式二：镜像模式（dom）
// ---------------------------------------------------------------------------

/**
 * 把指定标签镜像进画中画。
 * 步骤：关掉 hub（互斥）→ 恢复上一个镜像所有者 → 激活目标标签 → 注入启动。
 */
async function startDom(tabId) {
  if (!tabId) return { ok: false, reason: 'no-tab' };

  if (state.mode === 'hub') {
    await closeHub();
  }
  if (state.mode === 'dom' && state.dom && state.dom.ownerTabId !== tabId) {
    try {
      await sendToTab(state.dom.ownerTabId, { type: 'tpip-dom-restore' });
    } catch { /* 旧所有者已不可达，忽略 */ }
  }

  // 激活目标标签：保证页面可见，降低 requestWindow 被拒概率
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch { return { ok: false, reason: 'tab-gone' }; }
  await wait(120);

  const started = await injectDomStart(tabId);
  if (!started) {
    flashBadge('镜像启动失败：请在该标签页右下角的“画中画”按钮上直接点击一次。');
    return { ok: false, reason: 'activation-required' };
  }
  return { ok: true };
}

/**
 * 向目标标签注入“启动镜像”。内容脚本运行在 ISOLATED world，window.__tpip 也在那里。
 * 页面未就绪时轮询重试；userGesture:true 尽力提供瞬态激活。
 */
async function injectDomStart(tabId) {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        userGesture: true,
        func: () => {
          const api = window.__tpip;
          if (!api) return { ok: false, reason: 'not-ready' };
          return api.start(); // 返回 Promise
        },
      });
      const r = res && res[0] && res[0].result;
      if (r && r.ok) return true;
      if (r && r.reason && r.reason !== 'not-ready') return false;
    } catch (e) {
      console.warn('[TabPiP] injectDomStart failed:', String(e));
      return false;
    }
    await wait(250);
  }
  return false;
}

/** 镜像模式下，在标签顺序上向前/向后切换。 */
async function domNav(dir) {
  if (state.mode !== 'dom' || !state.dom) return { ok: false, reason: 'no-dom' };
  const tabs = await chrome.tabs.query({ windowId: state.dom.ownerWindowId });
  tabs.sort((a, b) => a.index - b.index);
  const idx = tabs.findIndex((t) => t.id === state.dom.ownerTabId);
  const target = tabs[idx + dir];
  if (!target) return { ok: false, reason: 'edge' };
  return startDom(target.id); // 内部会先恢复当前所有者，再镜像目标
}

async function closeDom() {
  if (state.mode === 'dom' && state.dom) {
    try {
      await sendToTab(state.dom.ownerTabId, { type: 'tpip-dom-restore' });
    } catch { /* 所有者已不可达，忽略 */ }
  }
  resetState();
  await saveState();
}

// ---------------------------------------------------------------------------
// 标签页右键菜单
// ---------------------------------------------------------------------------

const MENU_ITEMS = [
  {
    id: 'tpip-show-hub',
    title: '在画中画小窗中显示此标签',
    contexts: ['tab'],
  },
  {
    id: 'tpip-mirror-tab',
    title: '镜像此标签到画中画（任何网站可用）',
    contexts: ['tab'],
  },
  {
    id: 'tpip-close',
    title: '关闭画中画',
    contexts: ['tab', 'page', 'action'],
  },
];

function initContextMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create(item, () => {
        if (chrome.runtime.lastError) {
          console.warn('[TabPiP] contextMenu:', chrome.runtime.lastError.message);
        }
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await loadState();
  switch (info.menuItemId) {
    case 'tpip-show-hub': {
      // 右键的标签 → 画中画小窗（自动启动画中画台并显示该标签；
      // 站点禁止嵌入时，小窗会显示标题占位面板，可再用下方「镜像」）
      const r = await startHub({ setTabId: tab ? tab.id : null });
      if (!r.ok) flashBadge('画中画启动失败：请在控制台页点一次「启动画中画窗口」按钮');
      break;
    }
    case 'tpip-mirror-tab': {
      const u = tab ? (tab.url || '') : '';
      if (!/^https?:/.test(u)) {
        flashBadge('该页面无法镜像（仅支持 http/https 页面）');
        break;
      }
      const r = await startDom(tab.id);
      if (!r.ok) flashBadge('镜像启动失败：请在该标签页右下角点一次「画中画」按钮');
      break;
    }
    case 'tpip-close': {
      if (state.mode === 'hub') await closeHub();
      else if (state.mode === 'dom') await closeDom();
      break;
    }
  }
  await saveState();
});

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  await loadState();
  switch (command) {
    case 'start-pip': {
      if (state.mode === 'hub' && state.hub) {
        // 已启动 → 切换“跟随当前标签”
        try { await sendToTab(state.hub.consoleTabId, { type: 'tpip-hub-toggle-follow' }); } catch {}
      } else {
        const r = await startHub();
        if (!r.ok) flashBadge('请到画中画控制台点一次“启动画中画窗口”');
      }
      break;
    }
    case 'prev-tab': await navCmd(-1); break;
    case 'next-tab': await navCmd(1); break;
    case 'close-pip': {
      if (state.mode === 'hub') await closeHub();
      else if (state.mode === 'dom') await closeDom();
      break;
    }
  }
  await saveState();
});

/** 上/下一个标签：hub 模式下让控制台切换 iframe；dom 模式下迁移镜像；都未启动则直接镜像相邻标签。 */
async function navCmd(dir) {
  if (state.mode === 'hub' && state.hub) {
    try {
      await sendToTab(state.hub.consoleTabId, { type: 'tpip-hub-nav', dir });
    } catch {}
  } else if (state.mode === 'dom') {
    await domNav(dir);
  } else {
    const active = await getActiveTab();
    if (!active) return;
    const tabs = await chrome.tabs.query({ windowId: active.windowId });
    tabs.sort((a, b) => a.index - b.index);
    const idx = tabs.findIndex((t) => t.id === active.id);
    const target = tabs[idx + dir];
    if (target) await startDom(target.id);
  }
}

// ---------------------------------------------------------------------------
// 消息路由（内容脚本 / 控制台页 / popup → 后台）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tpip-')) return;

  (async () => {
    await loadState();
    switch (msg.type) {
      // ---- 内容脚本（镜像模式） ----
      case 'tpip-dom-request': {
        // 页面悬浮按钮点击，询问是否可以开始镜像
        if (state.mode === 'hub') {
          sendResponse({ go: false, reason: 'hub-active' });
        } else if (state.mode === 'dom' && state.dom && sender.tab && state.dom.ownerTabId === sender.tab.id) {
          sendResponse({ go: false, reason: 'already' });
        } else {
          sendResponse({ go: true });
        }
        break;
      }
      case 'tpip-dom-started': {
        state = {
          mode: 'dom',
          hub: null,
          dom: { ownerTabId: sender.tab?.id, ownerWindowId: sender.tab?.windowId },
        };
        await saveState();
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-dom-closed': {
        if (state.mode === 'dom' && state.dom && sender.tab && state.dom.ownerTabId === sender.tab.id) {
          resetState();
          await saveState();
        }
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-dom-nav': {
        await domNav(msg.dir);
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-dom-restore-request': {
        await closeDom();
        sendResponse({ ok: true });
        break;
      }

      // ---- 控制台页（hub 模式） ----
      case 'tpip-hub-state': {
        if (msg.active) {
          state = {
            mode: 'hub',
            hub: { consoleTabId: sender.tab?.id, consoleWindowId: sender.tab?.windowId, follow: !!msg.follow },
            dom: null,
          };
        } else if (state.mode === 'hub') {
          resetState();
        }
        await saveState();
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-hub-closed': {
        if (state.mode === 'hub') {
          resetState();
          await saveState();
        }
        sendResponse({ ok: true });
        break;
      }

      // ---- popup ----
      case 'tpip-status': {
        sendResponse({ state, settings: await loadSettings() });
        break;
      }
      case 'tpip-open-console': {
        await openConsole();
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-hub-start': {
        sendResponse(await startHub({ setTabId: msg.setTabId }));
        break;
      }
      case 'tpip-hub-set': {
        if (state.mode === 'hub' && state.hub) {
          try { await sendToTab(state.hub.consoleTabId, { type: 'tpip-hub-set', tabId: msg.tabId }); } catch {}
          sendResponse({ ok: true });
        } else {
          sendResponse(await startHub({ setTabId: msg.tabId }));
        }
        break;
      }
      case 'tpip-hub-toggle-follow': {
        if (state.mode === 'hub' && state.hub) {
          try { await sendToTab(state.hub.consoleTabId, { type: 'tpip-hub-toggle-follow' }); } catch {}
        }
        sendResponse({ ok: true });
        break;
      }
      case 'tpip-dom-start': {
        sendResponse(await startDom(msg.tabId));
        break;
      }
      case 'tpip-close': {
        if (state.mode === 'hub') await closeHub();
        else if (state.mode === 'dom') await closeDom();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, reason: 'unknown' });
    }
  })();

  return true; // 异步 sendResponse
});

// ---------------------------------------------------------------------------
// 标签生命周期兜底
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (state.mode === 'hub' && state.hub && state.hub.consoleTabId === tabId) {
    // 控制台页被关闭 → PiP 窗口自动关闭（规范：PiP 不活过打开者）
    resetState();
    await saveState();
  } else if (state.mode === 'dom' && state.dom && state.dom.ownerTabId === tabId) {
    // 镜像所有者被关闭 → PiP 自动关闭
    resetState();
    await saveState();
  }
});

// Service Worker 冷启动时恢复状态；安装/更新时注册右键菜单
chrome.runtime.onInstalled.addListener(() => {
  initContextMenus();
  loadState();
});
loadState();
