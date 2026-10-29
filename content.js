/**
 * Tab PiP Studio —— 内容脚本（镜像模式）
 *
 * 运行在 ISOLATED world，注入所有普通网页（<all_urls>）。
 * 能力：
 *   1. 页面右下角悬浮“画中画”按钮：真实用户手势 → requestWindow() 稳定可用。
 *   2. 把当前标签的 DOM（连同 <head> 样式）整体搬进画中画窗口，任何网站都能显示，
 *      包括那些禁止被 iframe 嵌入的站点（X-Frame-Options / CSP frame-ancestors）。
 *   3. 镜像窗口顶部工具条：上一个/下一个标签（消息给后台编排）、返回标签并关闭。
 *   4. 暴露 window.__tpip，供后台 scripting.executeScript(userGesture:true) 从快捷键路径注入启动。
 *
 * 已知取舍（README 有说明）：
 *   - 镜像期间源标签的 body 会被搬空；关闭/返回时原样移回（滚动位置也还原）。
 *   - 对重度动态页面（SPA 不断重绘 body），新产生的节点会回流到源标签，属于该方案的固有限制。
 *   - 若源标签被关闭/导航，规范保证 PiP 窗口自动关闭（其中的内容随之销毁，无法找回）。
 */

(() => {
  'use strict';
  if (window.top !== window) return; // 只处理顶层页面
  if (!('documentPictureInPicture' in window)) return; // 浏览器不支持（Chrome/Edge ≥116）
  if (location.protocol === 'chrome-extension:' || location.protocol === 'chrome:') return;

  let pipWindow = null; // 本页打开的 PiP 窗口
  let savedScroll = { top: 0, left: 0 };
  let hostBtn = null;

  /** PiP 窗口内工具条的样式（注入到 PiP 文档）。 */
  const PIP_STYLE = `
    .tpip-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      background: #0f172a; color: #e2e8f0;
      font: 13px/1 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
      border-bottom: 1px solid rgba(255,255,255,.12);
      user-select: none;
      box-sizing: border-box;
    }
    .tpip-bar button {
      border: 1px solid rgba(255,255,255,.25); border-radius: 6px;
      background: rgba(255,255,255,.08); color: #e2e8f0;
      padding: 4px 10px; cursor: pointer; font: inherit;
    }
    .tpip-bar button:hover { background: rgba(255,255,255,.18); }
    .tpip-bar .tpip-title {
      flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
      color: #94a3b8; font-size: 12px;
    }
  `;

  // -------------------------------------------------------------------------
  // 悬浮按钮
  // -------------------------------------------------------------------------

  function ensureButton() {
    if (hostBtn) return;
    if (pipWindow && !pipWindow.closed) return;
    hostBtn = document.createElement('button');
    hostBtn.className = 'tpip-fab';
    hostBtn.title = 'Tab PiP Studio：把此页镜像到画中画窗口（任何网站可用）';
    hostBtn.textContent = '画中画';
    hostBtn.addEventListener('click', async () => {
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'tpip-dom-request' });
      } catch { resp = null; }
      if (resp && resp.go) {
        const r = await startMirror();
        if (r && r.ok) hideButton();
      }
    });
    // 挂在 documentElement 而非 body：body 可能被镜像搬空或被 SPA 替换
    document.documentElement.appendChild(hostBtn);
  }

  function hideButton() {
    if (hostBtn) {
      hostBtn.remove();
      hostBtn = null;
    }
  }

  function showButton() {
    ensureButton();
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  async function getSettings() {
    const got = await chrome.storage.local.get('tpip:settings');
    return { pipWidth: 960, pipHeight: 640, ...(got['tpip:settings'] || {}) };
  }

  // -------------------------------------------------------------------------
  // 镜像引擎
  // -------------------------------------------------------------------------

  async function startMirror() {
    if (pipWindow && !pipWindow.closed) return { ok: false, reason: 'already' };
    if (!document.body) return { ok: false, reason: 'no-body' };
    if (!document.body.children.length) return { ok: false, reason: 'empty-body' };

    let pip;
    try {
      const s = await getSettings();
      pip = await documentPictureInPicture.requestWindow({
        width: s.pipWidth,
        height: s.pipHeight,
        disallowReturnToOpener: true, // 隐藏浏览器的“返回标签”按钮，用我们自己的工具条
      });
    } catch (e) {
      // 常见原因：没有用户手势 / 从非顶层调用 / 浏览器设置禁用
      return { ok: false, reason: String(e && e.name ? e.name : e) };
    }

    pipWindow = pip;

    // 生命周期兜底：PiP 窗口以任何方式被关闭（含源标签被关）时清理引用并通知后台
    pip.addEventListener('pagehide', () => {
      pipWindow = null;
      chrome.runtime.sendMessage({ type: 'tpip-dom-closed' }).catch(() => {});
    });

    buildPipUi(pip);
    moveContentToPip(pip);
    chrome.runtime.sendMessage({ type: 'tpip-dom-started' }).catch(() => {});
    return { ok: true };
  }

  /** 在 PiP 窗口里放一条工具条。事件处理器都绑定在“本页（打开者）”的上下文里，随节点常驻。 */
  function buildPipUi(pip) {
    const doc = pip.document;
    const style = doc.createElement('style');
    style.textContent = PIP_STYLE;
    doc.head.appendChild(style);

    const bar = doc.createElement('div');
    bar.className = 'tpip-bar';
    bar.innerHTML = `
      <button data-act="prev" title="上一个标签（Alt+Shift+←）">‹ 上一个</button>
      <button data-act="next" title="下一个标签（Alt+Shift+→）">下一个 ›</button>
      <span class="tpip-title"></span>
      <button data-act="restore" title="把内容移回原标签并关闭画中画">返回标签</button>
      <button data-act="close" title="关闭画中画">×</button>`;

    bar.querySelector('[data-act="prev"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'tpip-dom-nav', dir: -1 }).catch(() => {});
    });
    bar.querySelector('[data-act="next"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'tpip-dom-nav', dir: 1 }).catch(() => {});
    });
    bar.querySelector('[data-act="restore"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'tpip-dom-restore-request' }).catch(() => {});
    });
    bar.querySelector('[data-act="close"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'tpip-dom-restore-request' }).catch(() => {});
    });
    bar.querySelector('.tpip-title').textContent = document.title || location.href;

    doc.body.appendChild(bar);
  }

  /** 把本页的样式（head 克隆）与 body 内容整体搬进 PiP 窗口，并尽量还原滚动位置。 */
  function moveContentToPip(pip) {
    const srcDoc = document;
    const dstDoc = pip.document;

    const sc = srcDoc.scrollingElement || srcDoc.documentElement;
    savedScroll = { top: sc.scrollTop, left: sc.scrollLeft };

    // 1. 样式：head 子节点克隆到 PiP 文档（否则页面会失去全部样式）
    for (const node of [...srcDoc.head.childNodes]) {
      if (node.nodeType === 1) {
        const clone = node.cloneNode(true);
        dstDoc.head.appendChild(clone);
      }
    }

    // 2. body 属性（class / style 等）
    dstDoc.body.className = srcDoc.body.className;
    for (const attr of [...srcDoc.body.attributes]) {
      try { dstDoc.body.setAttribute(attr.name, attr.value); } catch { /* 忽略非法属性 */ }
    }

    // 3. 移动 body 的子元素（appendChild 会自动 adopt 到目标文档；事件监听随节点走）
    const kids = [...srcDoc.body.children];
    for (const k of kids) dstDoc.body.appendChild(k);

    // 4. 还原滚动位置到 PiP 窗口
    const sc2 = dstDoc.scrollingElement || dstDoc.documentElement;
    sc2.scrollTop = savedScroll.top;
    sc2.scrollLeft = savedScroll.left;
  }

  /** 把内容从 PiP 窗口移回本页，关闭 PiP，恢复悬浮按钮。 */
  function restoreContent() {
    if (!pipWindow || pipWindow.closed) return { ok: false, reason: 'no-pip' };
    const pipDoc = pipWindow.document;

    const kids = [...pipDoc.body.children].filter((el) => !el.classList.contains('tpip-bar'));
    for (const k of kids) document.body.appendChild(k);

    const sc = document.scrollingElement || document.documentElement;
    sc.scrollTop = savedScroll.top;
    sc.scrollLeft = savedScroll.left;

    try { pipWindow.close(); } catch { /* 可能已被外部关闭 */ }
    pipWindow = null;
    chrome.runtime.sendMessage({ type: 'tpip-dom-closed' }).catch(() => {});
    showButton();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 暴露给后台 scripting.executeScript（快捷键/按钮注入路径）
  // -------------------------------------------------------------------------

  window.__tpip = {
    start: startMirror,
    restore: restoreContent,
    get active() {
      return !!(pipWindow && !pipWindow.closed);
    },
  };

  // -------------------------------------------------------------------------
  // 消息监听
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'tpip-dom-restore': {
        sendResponse(restoreContent());
        break;
      }
      case 'tpip-dom-status': {
        sendResponse({ active: !!(pipWindow && !pipWindow.closed) });
        break;
      }
      default:
        return; // 不响应未知消息
    }
    return true;
  });

  // 页面就绪后放按钮
  ensureButton();
})();
