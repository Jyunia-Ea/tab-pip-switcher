/**
 * Tab PiP Studio —— popup
 * 快捷入口：打开控制台 / 启动画中画台 / 镜像当前标签 / 关闭画中画 / 跟随开关
 * 以及全部标签列表（搜索 + 单标签操作）。
 */

(() => {
  'use strict';

  const els = {
    console: document.getElementById('btn-console'),
    start: document.getElementById('btn-start'),
    mirrorActive: document.getElementById('btn-mirror-active'),
    close: document.getElementById('btn-close'),
    status: document.getElementById('status'),
    follow: document.getElementById('follow'),
    search: document.getElementById('search'),
    tabs: document.getElementById('tabs'),
  };

  let tabsCache = [];
  let myState = { mode: null, hub: null, dom: null };
  let myActiveTabId = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'status' + (cls ? ' ' + cls : '');
  }

  function describeState() {
    if (myState.mode === 'hub') return '画中画台（跟随：' + (myState.hub?.follow ? '开' : '关') + '）';
    if (myState.mode === 'dom' && myState.dom) return '镜像模式（标签 #' + myState.dom.ownerTabId + '）';
    return '未启动';
  }

  async function refreshStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'tpip-status' });
      myState = resp.state;
      els.follow.disabled = myState.mode !== 'hub';
      els.follow.checked = !!(myState.hub && myState.hub.follow);
      setStatus('当前模式：' + describeState(), myState.mode ? 'on' : '');
      els.start.disabled = myState.mode === 'hub';
      els.mirrorActive.disabled = myState.mode === 'dom';
    } catch {
      setStatus('无法连接后台 Service Worker', 'warn');
    }
  }

  async function refreshTabs() {
    tabsCache = await chrome.tabs.query({});
    tabsCache.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
    renderTabs();
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
          <button data-act="hub" title="在画中画台中显示此标签">画中画台</button>
          <button data-act="mirror" title="镜像此标签（任何网站可用）">镜像</button>
        </div>`;
      li.querySelector('[data-act="hub"]').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'tpip-hub-set', tabId: t.id }).then(() => window.close());
      });
      li.querySelector('[data-act="mirror"]').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'tpip-dom-start', tabId: t.id }).then(() => window.close());
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

  els.console.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'tpip-open-console' }).then(() => window.close());
  });
  els.start.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'tpip-hub-start' }).then(() => window.close());
  });
  els.mirrorActive.addEventListener('click', () => {
    if (myActiveTabId == null) return;
    chrome.runtime.sendMessage({ type: 'tpip-dom-start', tabId: myActiveTabId }).then(() => window.close());
  });
  els.close.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'tpip-close' }).then(() => window.close());
  });
  els.follow.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'tpip-hub-toggle-follow' });
  });
  els.search.addEventListener('input', () => renderTabs());

  (async function init() {
    await refreshStatus();
    await refreshTabs();
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    myActiveTabId = active ? active.id : null;
  })();
})();
