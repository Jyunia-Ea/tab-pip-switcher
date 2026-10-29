/**
 * Tab PiP Studio —— 画中画控制台页（hub 模式）
 *
 * 运行在扩展页（chrome-extension://…/pip-console.html，MAIN world）。
 * 职责：
 *   1. 列出所有标签页，可搜索、可一键“画中画台 / 镜像”。
 *   2. 点击“启动画中画窗口” → requestWindow() → 在 PiP 窗口里放一个工具条 + <iframe>。
 *   3. 切换标签 = 改 iframe.src：瞬间完成，适合“来回切换标签页”。
 *   4. “跟随当前标签”：切屏/切应用时，画中画自动镜像当前激活的标签。
 *   5. 探测目标站点是否允许被 iframe 嵌入（X-Frame-Options / CSP frame-ancestors），
 *      不允许则显示占位面板（标题 + 在新标签打开）。
 *
 * 消息协议（后台 → 本页）：
 *   tpip-hub-nav {dir} / tpip-hub-set {tabId} / tpip-hub-toggle-follow / tpip-hub-close
 * 本页 → 后台：tpip-hub-state {active, follow} / tpip-hub-closed
 */

(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  let pipWindow = null;      // 打开的 PiP 窗口（null 表示未启动）
  let currentTabId = null;   // 当前显示在画中画里的标签
  let follow = false;        // 跟随当前标签
  let closedByUs = false;    // 关闭去重标记
  let tabsCache = [];

  const els = {
    start: document.getElementById('btn-start'),
    close: document.getElementById('btn-close'),
    prev: document.getElementById('btn-prev'),
    next: document.getElementById('btn-next'),
    follow: document.getElementById('follow'),
    status: document.getElementById('status'),
    search: document.getElementById('search'),
    tabs: document.getElementById('tabs'),
    w: document.getElementById('w'),
    h: document.getElementById('h'),
    save: document.getElementById('btn-save'),
  };

  /** PiP 窗口内 UI 的样式。 */
  const PIP_CSS = `
    html, body { height: 100%; margin: 0; background: #0f172a; }
    body { position: relative; font: 13px/1 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .tpip-bar {
      display: flex; align-items: center; gap: 6px;
      height: 40px; padding: 0 8px; box-sizing: border-box;
      background: #0f172a; color: #e2e8f0;
      border-bottom: 1px solid rgba(255,255,255,.12);
      user-select: none;
    }
    .tpip-bar button {
      border: 1px solid rgba(255,255,255,.25); border-radius: 6px;
      background: rgba(255,255,255,.08); color: #e2e8f0;
      padding: 4px 10px; cursor: pointer; font: inherit; white-space: nowrap;
    }
    .tpip-bar button:hover { background: rgba(255,255,255,.18); }
    .tpip-bar .tpip-follow {
      background: transparent; border-color: rgba(255,255,255,.2);
    }
    .tpip-bar .tpip-follow.on { background: rgba(15,118,110,.7); border-color: transparent; }
    .tpip-select {
      flex: 1; min-width: 0; max-width: 320px;
      background: #1e293b; color: #e2e8f0;
      border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
      padding: 4px 6px; font: inherit;
    }
    .tpip-frame {
      display: block; width: 100%; height: calc(100% - 40px);
      border: 0; background: #ffffff;
    }
    .tpip-placeholder {
      position: absolute; inset: 40px 0 0 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 24px; text-align: center;
      color: #94a3b8; background: #0f172a;
    }
    .tpip-placeholder strong { color: #e2e8f0; font-size: 15px; }
    .tpip-placeholder .u { font-size: 12px; word-break: break-all; max-width: 80%; }
    .tpip-placeholder p { margin: 4px 0 0; font-size: 12px; }
    .tpip-placeholder button {
      border: 1px solid rgba(255,255,255,.3); border-radius: 6px;
      background: rgba(255,255,255,.1); color: #e2e8f0;
      padding: 6px 14px; cursor: pointer; font: inherit;
    }
    .tpip-placeholder button:hover { background: rgba(255,255,255,.2); }
  `;

  // PiP 窗口内的元素引用
  let pipEls = null; // { bar, select, frame, placeholder, followBtn }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  const DEFAULT_SETTINGS = { pipWidth: 960, pipHeight: 640, followByDefault: false };

  async function getSettings() {
    const got = await chrome.storage.local.get('tpip:settings');
    return { ...DEFAULT_SETTINGS, ...(got['tpip:settings'] || {}) };
  }

  async function saveSettings(patch) {
    const s = await getSettings();
    const next = { ...s, ...patch };
    await chrome.storage.local.set({ 'tpip:settings': next });
    return next;
  }

  // -------------------------------------------------------------------------
  // 状态上报 / UI
  // -------------------------------------------------------------------------

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'status' + (cls ? ' ' + cls : '');
  }

  function notifyState() {
    chrome.runtime.sendMessage({
      type: 'tpip-hub-state',
      active: !!(pipWindow && !pipWindow.closed),
      follow,
    }).catch(() => {});
  }

  function notifyClosed() {
    chrome.runtime.sendMessage({ type: 'tpip-hub-closed' }).catch(() => {});
  }

  function syncUi() {
    const active = !!(pipWindow && !pipWindow.closed);
    els.start.disabled = active;
    els.close.disabled = !active;
    els.prev.disabled = !active;
    els.next.disabled = !active;
    els.follow.checked = follow;
    if (pipEls) {
      pipEls.followBtn.textContent = '跟随:' + (follow ? '开' : '关');
      pipEls.followBtn.classList.toggle('on', follow);
    }
  }

  // -------------------------------------------------------------------------
  // 标签列表
  // -------------------------------------------------------------------------

  async function refreshTabs() {
    tabsCache = await chrome.tabs.query({});
    tabsCache.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
    renderTabs();
    updatePipSelect();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderTabs() {
    const q = (els.search.value || '').trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (const t of tabsCache) {
      if (q && !`${t.title || ''} ${t.url || ''}`.toLowerCase().includes(q)) continue;
      shown++;
      const li = document.createElement('li');
      li.className = 'tab-item' + (t.active ? ' active' : '');
      const fav = t.favIconUrl ? `<img class="fav" src="${esc(t.favIconUrl)}" alt="" />` : '<span class="fav"></span>';
      li.innerHTML = `${fav}
        <div class="meta">
          <div class="title">${esc(t.title || '')}</div>
          <div class="url">${esc(t.url || '')}</div>
        </div>
        <div class="btns">
          <button data-act="hub" title="在画中画台中显示此标签（快速切换）">画中画台</button>
          <button data-act="mirror" title="镜像此标签到画中画（任何网站可用，含禁止嵌入的站点）">镜像</button>
        </div>`;
      li.querySelector('[data-act="hub"]').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'tpip-hub-set', tabId: t.id });
      });
      li.querySelector('[data-act="mirror"]').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'tpip-dom-start', tabId: t.id });
      });
      frag.appendChild(li);
    }

    els.tabs.replaceChildren(frag);
    if (!shown) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = q ? '没有匹配的标签页' : '没有打开的标签页';
      els.tabs.appendChild(empty);
    }
  }

  /** 同步 PiP 窗口里的下拉选择器。 */
  function updatePipSelect() {
    if (!pipEls) return;
    const sel = pipEls.select;
    const myWindowId = currentWindowIdCache;
    const opts = [`<option value="follow">（跟随当前标签）</option>`];
    for (const t of tabsCache) {
      if (t.windowId !== myWindowId) continue;
      const label = `${t.index + 1}. ${(t.title || t.url || '').slice(0, 40)}`;
      opts.push(`<option value="${t.id}" ${t.id === currentTabId ? 'selected' : ''}>${esc(label)}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = follow ? 'follow' : String(currentTabId ?? '');
  }

  let currentWindowIdCache = null;

  // -------------------------------------------------------------------------
  // 能否被 iframe 嵌入（响应头探测 + 兜底）
  // -------------------------------------------------------------------------

  function basicFramable(url) {
    return /^https?:/.test(url || '');
  }

  /** 用扩展的主机权限探测响应头，提前判断是否禁止嵌入。失败时乐观放行（交给 iframe 实际表现）。 */
  async function checkFramable(tab) {
    const u = tab.url || '';
    if (!basicFramable(u)) return false;
    try {
      const res = await fetch(u, { method: 'HEAD', credentials: 'omit', cache: 'no-store' });
      const xfo = res.headers.get('x-frame-options');
      if (xfo) {
        const v = xfo.trim().toUpperCase();
        if (v === 'DENY' || v === 'SAMEORIGIN') return false;
      }
      const csp = res.headers.get('content-security-policy');
      if (csp) {
        const m = csp.match(/frame-ancestors\s+([^;]+)/i);
        if (m) {
          const dir = m[1].trim().toLowerCase();
          if (dir === 'none') return false;
          if (dir !== '*') {
            // 只允许自身/显式来源，跨源嵌入基本会失败
            const hasScheme = /https?:/.test(dir);
            if (!hasScheme) return false;
          }
        }
      }
      return true;
    } catch {
      return true; // 探测失败，乐观放行
    }
  }

  // -------------------------------------------------------------------------
  // 启动 / 关闭
  // -------------------------------------------------------------------------

  /**
   * 启动画中画窗口。可由页面按钮点击（真实手势）或后台 executeScript(userGesture) 触发。
   */
  async function start(setTabId) {
    if (pipWindow && !pipWindow.closed) {
      if (setTabId) await setTab(setTabId);
      return { ok: true, reason: 'already' };
    }

    const s = await getSettings();
    let pip;
    try {
      pip = await documentPictureInPicture.requestWindow({
        width: s.pipWidth,
        height: s.pipHeight,
        disallowReturnToOpener: true,
      });
    } catch (e) {
      const reason = e && e.name ? e.name : String(e);
      setStatus(
        '启动失败（' + reason + '）：需要一次真实点击手势。请在“启动画中画窗口”按钮上直接点击。',
        'warn'
      );
      return { ok: false, reason };
    }

    pipWindow = pip;
    closedByUs = false;
    pip.addEventListener('pagehide', () => {
      pipWindow = null;
      pipEls = null;
      if (!closedByUs) {
        setStatus('画中画已关闭（窗口被外部关闭）');
        notifyClosed();
      }
      syncUi();
    });

    buildPipUi(pip);
    follow = s.followByDefault;
    els.follow.checked = follow;
    syncUi();

    const target = setTabId ?? (await getActiveTabId());
    await setTab(target);

    setStatus(follow ? '画中画已启动（跟随当前标签）' : '画中画已启动');
    notifyState();
    return { ok: true };
  }

  /** 后台注入自动启动的入口（world: MAIN）。 */
  async function autoStart(setTabId) {
    if (pipWindow && !pipWindow.closed) {
      if (setTabId) await setTab(setTabId);
      return { ok: true, reason: 'already' };
    }
    return start(setTabId);
  }

  function buildPipUi(pip) {
    const doc = pip.document;
    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);

    const bar = doc.createElement('div');
    bar.className = 'tpip-bar';
    bar.innerHTML = `
      <button data-act="prev" title="上一个标签（Alt+Shift+←）">‹ 上一个</button>
      <button data-act="next" title="下一个标签（Alt+Shift+→）">下一个 ›</button>
      <select class="tpip-select" title="选择要显示的标签"></select>
      <button class="tpip-follow" data-act="follow" title="跟随当前激活的标签">跟随:关</button>
      <button data-act="close" title="关闭画中画">×</button>`;

    const select = bar.querySelector('.tpip-select');
    const followBtn = bar.querySelector('[data-act="follow"]');

    bar.querySelector('[data-act="prev"]').addEventListener('click', () => nav(-1));
    bar.querySelector('[data-act="next"]').addEventListener('click', () => nav(1));
    followBtn.addEventListener('click', () => setFollow(!follow));
    bar.querySelector('[data-act="close"]').addEventListener('click', () => close());
    select.addEventListener('change', () => {
      const v = select.value;
      if (v === 'follow') {
        setFollow(true);
      } else {
        setFollow(false);
        const id = Number(v);
        if (Number.isInteger(id)) setTab(id);
      }
    });

    const frame = doc.createElement('iframe');
    frame.className = 'tpip-frame';
    frame.allow = 'fullscreen; autoplay; picture-in-picture; encrypted-media';
    // 不加 sandbox：保持与普通浏览一致的嵌入能力（禁止嵌入的站点由网络层 X-Frame-Options/CSP 拦截，
    // 我们已用响应头预检并给出标题占位面板）

    const placeholder = doc.createElement('div');
    placeholder.className = 'tpip-placeholder';
    placeholder.style.display = 'none';

    doc.body.append(bar, frame, placeholder);
    pipEls = { bar, select, frame, placeholder, followBtn };
  }

  async function close() {
    if (pipWindow && !pipWindow.closed) {
      closedByUs = true;
      try { pipWindow.close(); } catch { /* 已关闭 */ }
    }
    pipWindow = null;
    pipEls = null;
    setStatus('画中画已关闭');
    syncUi();
    notifyClosed();
  }

  // -------------------------------------------------------------------------
  // 切换标签
  // -------------------------------------------------------------------------

  async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ? tab.id : null;
  }

  async function getTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /** 把指定标签显示到画中画窗口（iframe 或占位面板）。 */
  async function setTab(tabId) {
    if (!pipWindow || pipWindow.closed) return;
    const tab = await getTab(tabId);
    if (!tab) return;
    currentTabId = tabId;
    const pip = pipWindow;
    const { select, frame, placeholder } = pipEls;

    const framable = await checkFramable(tab);
    if (framable) {
      placeholder.style.display = 'none';
      if (frame.getAttribute('src') !== tab.url) {
        frame.setAttribute('src', tab.url);
      }
    } else {
      frame.setAttribute('src', 'about:blank');
      placeholder.style.display = 'flex';
      placeholder.innerHTML = `
        <strong>${esc(tab.title || '')}</strong>
        <span class="u">${esc(tab.url || '')}</span>
        <p>该页面禁止被嵌入（X-Frame-Options / CSP frame-ancestors）。</p>
        <button data-act="open-tab">在新标签页打开</button>
        <button data-act="force-frame">仍尝试嵌入</button>`;
      placeholder.querySelector('[data-act="open-tab"]').addEventListener('click', () => {
        chrome.tabs.update(tab.id, { active: true });
      });
      placeholder.querySelector('[data-act="force-frame"]').addEventListener('click', () => {
        placeholder.style.display = 'none';
        frame.setAttribute('src', tab.url);
      });
    }

    select.value = String(tabId);
    updatePipSelect();
  }

  /** 在“当前显示标签”的前后切换（控制台所在窗口的标签顺序）。 */
  async function nav(dir) {
    if (!pipWindow || pipWindow.closed) return;
    if (currentTabId == null) return;

    const winId = await getMyWindowId();
    const tabs = (await chrome.tabs.query({ windowId: winId })).sort((a, b) => a.index - b.index);
    const idx = tabs.findIndex((t) => t.id === currentTabId);
    const target = tabs[idx + dir];
    if (!target) return;
    setFollow(false);
    await setTab(target.id);
  }

  function setFollow(v) {
    follow = v;
    els.follow.checked = v;
    if (pipEls) {
      pipEls.followBtn.textContent = '跟随:' + (v ? '开' : '关');
      pipEls.followBtn.classList.toggle('on', v);
    }
    if (v && pipWindow && !pipWindow.closed) {
      getActiveTabId().then((id) => id && setTab(id));
    }
    notifyState();
  }

  async function getMyWindowId() {
    if (currentWindowIdCache != null) return currentWindowIdCache;
    try {
      const me = await chrome.tabs.getCurrent();
      currentWindowIdCache = me ? me.windowId : null;
    } catch {
      currentWindowIdCache = null;
    }
    return currentWindowIdCache;
  }

  // -------------------------------------------------------------------------
  // 跟随当前标签（切屏场景的核心）
  // -------------------------------------------------------------------------

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (follow && pipWindow && !pipWindow.closed) {
      const tab = await getTab(tabId);
      if (tab) await setTab(tabId);
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!follow || !pipWindow || pipWindow.closed) return;
    if (info.status === 'complete' && tabId === currentTabId) {
      // 当前显示的标签 URL 变了（重定向/SPA 导航），重新加载 iframe
      const tab = await getTab(tabId);
      if (tab) await setTab(tabId);
    }
  });

  chrome.tabs.onCreated.addListener(() => refreshTabs());
  chrome.tabs.onRemoved.addListener(() => refreshTabs());

  // -------------------------------------------------------------------------
  // 后台消息
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('tpip-')) return;
    switch (msg.type) {
      case 'tpip-hub-nav':
        nav(msg.dir).then(() => sendResponse({ ok: true }));
        return true;
      case 'tpip-hub-set':
        setTab(msg.tabId).then(() => sendResponse({ ok: true }));
        return true;
      case 'tpip-hub-toggle-follow':
        setFollow(!follow);
        sendResponse({ ok: true });
        break;
      case 'tpip-hub-close':
        close();
        sendResponse({ ok: true });
        break;
      default:
        return;
    }
    return true;
  });

  // -------------------------------------------------------------------------
  // 页面 UI 事件与初始化
  // -------------------------------------------------------------------------

  els.start.addEventListener('click', () => start().then((r) => { if (!r.ok) setStatus('启动失败，请重试或查看控制台', 'warn'); }));
  els.close.addEventListener('click', () => close());
  els.prev.addEventListener('click', () => nav(-1));
  els.next.addEventListener('click', () => nav(1));
  els.follow.addEventListener('change', () => setFollow(els.follow.checked));
  els.search.addEventListener('input', () => renderTabs());
  els.save.addEventListener('click', async () => {
    const w = Number(els.w.value), h = Number(els.h.value);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 240) {
      setStatus('尺寸无效（宽≥320，高≥240）', 'warn');
      return;
    }
    await saveSettings({ pipWidth: w, pipHeight: h });
    setStatus('尺寸已保存，下次启动生效');
  });

  (async function init() {
    const s = await getSettings();
    els.w.value = s.pipWidth;
    els.h.value = s.pipHeight;
    follow = s.followByDefault;
    els.follow.checked = follow;
    await refreshTabs();
    await getMyWindowId();
    syncUi();
  })();

  // 暴露给后台注入（world: MAIN）
  window.__pipConsole = {
    autoStart,
    start,
    close,
    setTab,
    nav,
    setFollow,
    get state() {
      return {
        active: !!(pipWindow && !pipWindow.closed),
        currentTabId,
        follow,
      };
    },
  };
})();
