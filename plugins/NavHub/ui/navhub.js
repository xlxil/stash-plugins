(() => {
  'use strict';
  if (window.NavHub) return;
  const STORAGE = 'stash.navhub.v1';
  const builtins = [
    { id:'pmv', label:'PMV Generator', selector:'.pmvg-nav-btn' },
    { id:'redtok', label:'RedTok', selector:'.redtok-nav-btn' },
    { id:'sfw', label:'SFW mode', selector:'#plugin_sfw' },
    { id:'storm', label:'Media Storm', selector:'.ms-nav-btn' },
    { id:'downloader', label:'Downloader', selector:'#stash-downloader-nav-button' },
    { id:'ostickers', label:'O Stickers', selector:'.ostickers-toggle-button' }
  ];
  let preferences = {};
  try { const saved = JSON.parse(localStorage.getItem(STORAGE)); if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved; } catch (_) { /* storage may be unavailable */ }
  const registry = new Map();
  const managed = new Set();
  const utilities = new Set();
  const refractMirrors = new Set();
  let host, trigger, pins, panel, backdrop, content, heading, closeButton, errorBox;
  let refractTrigger;
  let entries = [], open = false, settings = false, scheduled = false, signature = '';
  const media = window.matchMedia('(max-width: 1199.98px)');
  const refractMobile = window.matchMedia('(max-width: 900px)');
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(label, className, action) {
    const node = el('button', className, label); node.type = 'button';
    node.addEventListener('click', action); return node;
  }
  function pref(id) { return preferences[id] || {}; }
  function save(id, changes) {
    preferences[id] = { ...pref(id), ...changes };
    try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch (_) { /* session-only settings still work */ }
    sync(true);
  }
  function syncHidden(current, next, className) {
    for (const node of current) {
      if (next.has(node)) continue;
      node.classList.remove(className);
      current.delete(node);
    }
    for (const node of next) {
      if (!node.classList.contains(className)) node.classList.add(className);
      current.add(node);
    }
  }
  function usesRefractDock() {
    return refractMobile.matches && document.body.classList.contains('stash-liquid-glass');
  }
  function activeTrigger() {
    const button = usesRefractDock() ? refractTrigger : trigger;
    return button?.isConnected ? button : null;
  }
  function menuTrigger(label, className, onClick) {
    const node = button(label, className, onClick);
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-controls', 'nh-panel');
    node.setAttribute('aria-expanded', String(open));
    return node;
  }
  function mountRefractTrigger(burger) {
    if (!burger) { refractTrigger?.remove(); return; }
    if (!refractTrigger) {
      refractTrigger = menuTrigger('▦', 'nh-trigger nh-refract-trigger refract-dock-item', event => {
        event.stopPropagation();
        setOpen(!open);
      });
      refractTrigger.setAttribute('aria-label', 'Plugins');
      refractTrigger.title = 'Plugins';
    }
    if (burger.previousElementSibling !== refractTrigger) burger.before(refractTrigger);
  }
  function findRefractMirrors(nav, dock, sources) {
    const mirrors = new Set();
    if (!dock || !sources.size) return mirrors;
    const managedLinks = new Set([...sources].map(source => source.closest('a[href]')));
    const drawerLinks = new Set();
    const uniqueLinks = new Map();
    for (const link of nav.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      uniqueLinks.set(href, uniqueLinks.has(href) ? null : link);
    }
    // Only plugin route tiles can establish a match for a route in the dock.
    for (const tile of document.querySelectorAll('.refract-mobile-drawer .refract-drawer-tile[data-plugin-tile][data-href]')) {
      const href = tile.getAttribute('data-href');
      const link = uniqueLinks.get(href);
      if (!link || !managedLinks.has(link)) continue;
      mirrors.add(tile);
      drawerLinks.add(href);
    }
    for (const tile of dock.querySelectorAll('.refract-dock-item[data-href]')) {
      if (drawerLinks.has(tile.getAttribute('data-href'))) mirrors.add(tile);
    }
    for (const tile of document.querySelectorAll('.refract-mobile-drawer .refract-drawer-tile[data-action-selector], .refract-mobile-dock .refract-dock-item[data-action-selector]')) {
      try {
        // Refract resolves these selectors against the document on click.
        if (sources.has(document.querySelector(tile.dataset.actionSelector))) mirrors.add(tile);
      } catch (_) { /* Ignore selectors the theme cannot resolve. */ }
    }
    return mirrors;
  }
  function sourceFor(def, nav) {
    return def.selector ? nav.querySelector(def.selector) : null;
  }
  function state(entry) {
    const node = entry.source;
    return {
      disabled: Boolean(entry.disabled || node?.disabled || node?.getAttribute('aria-disabled') === 'true'),
      pressed: node?.getAttribute('aria-pressed') ?? (typeof entry.pressed === 'boolean' ? String(entry.pressed) : null)
    };
  }
  function icon(entry) {
    const wrap = el('span', 'nh-icon'); wrap.setAttribute('aria-hidden', 'true');
    const svg = entry.source?.querySelector('svg');
    if (svg) {
      const clone = svg.cloneNode(true);
      clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
      wrap.append(clone);
    } else wrap.textContent = entry.icon || '▦';
    return wrap;
  }
  async function activate(entry) {
    if (state(entry).disabled) return;
    setOpen(false, true);
    try {
      if (entry.source?.isConnected) entry.source.click();
      else if (entry.onClick) await entry.onClick();
      else throw new Error('This plugin is no longer available.');
    } catch (error) {
      console.error('[Nav Hub]', error);
      setOpen(true); errorBox.textContent = 'Could not run this action. Try again.';
    }
    schedule();
  }
  function actionButton(entry, pinned = false) {
    const node = button('', pinned ? 'nh-pin' : 'nh-item', () => activate(entry));
    node.dataset.nhId = entry.id; node.title = entry.label; node.append(icon(entry));
    node.append(el('span', 'nh-label', entry.label));
    const current = state(entry); node.disabled = current.disabled;
    if (current.pressed !== null) {
      node.setAttribute('aria-pressed', current.pressed);
      if (!pinned) node.append(el('span', 'nh-state', current.pressed === 'true' ? 'On' : 'Off'));
    }
    return node;
  }
  function position() {
    const opener = activeTrigger();
    if (!open || media.matches || !opener) return;
    const rect = opener.getBoundingClientRect();
    panel.style.top = `${Math.min(rect.bottom + 6, Math.max(8, innerHeight - 180))}px`;
    panel.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
  }
  function setOpen(value, returnFocus = false) {
    const opener = activeTrigger();
    if (value && usesRefractDock() && document.body.classList.contains('refract-burger-open')) {
      opener?.parentElement.querySelector(':scope > .refract-dock-burger')?.click();
    }
    open = value; panel.hidden = !value; backdrop.hidden = !value;
    trigger?.setAttribute('aria-expanded', String(value));
    refractTrigger?.setAttribute('aria-expanded', String(value));
    if (value) { settings = false; render(); position(); closeButton.focus(); }
    else if (returnFocus) opener?.focus();
  }
  function move(entry, direction) {
    const ordered = entries.map(e => e.id), from = ordered.indexOf(entry.id), to = from + direction;
    if (to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    ordered.forEach((id, index) => { preferences[id] = { ...pref(id), order:index }; });
    try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch (_) {}
    sync(true);
  }
  function render() {
    const active = document.activeElement;
    const focusId = content?.contains(active) ? active.dataset.nhFocus : null;
    heading.textContent = settings ? 'Plugin settings' : 'Plugins';
    content.replaceChildren(); errorBox.textContent = '';
    if (settings) {
      content.append(el('p', 'nh-note', 'Settings apply to this browser. Turn off Manage to restore the original button. Pinned shortcuts appear on desktop.'));
      entries.forEach((entry, index) => {
        const row = el('div', 'nh-setting'), title = el('div', 'nh-setting-title');
        title.append(el('span', '', entry.label));
        for (const [direction, symbol, description] of [[-1,'↑','Move up'],[1,'↓','Move down']]) {
          const control = button(symbol, 'nh-control', () => move(entry, direction));
          control.setAttribute('aria-label', `${description}: ${entry.label}`);
          control.dataset.nhFocus = `${entry.id}:${direction}`;
          control.disabled = direction === -1 ? index === 0 : index === entries.length - 1;
          title.append(control);
        }
        const options = el('div', 'nh-options');
        for (const [key, label, checked] of [['managed','Manage',pref(entry.id).managed !== false],['pinned','Pin',!!pref(entry.id).pinned]]) {
          const wrapper = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = checked;
          if (key === 'managed' && !entry.source) { input.checked = true; input.disabled = true; }
          input.dataset.nhFocus = `${entry.id}:${key}`;
          input.setAttribute('aria-label', `${label}: ${entry.label}`);
          input.addEventListener('change', () => save(entry.id, { [key]:input.checked }));
          wrapper.append(input, document.createTextNode(label)); options.append(wrapper);
        }
        row.append(title, options); content.append(row);
      });
    } else {
      const visible = entries.filter(e => (!e.source || pref(e.id).managed !== false));
      visible.forEach(entry => { const node = actionButton(entry); node.dataset.nhFocus = entry.id; content.append(node); });
      if (!visible.length) content.append(el('p', 'nh-empty', 'No managed plugins are available.'));
    }
    if (focusId) Array.from(content.querySelectorAll('[data-nh-focus]')).find(n => n.dataset.nhFocus === focusId)?.focus();
    pins.replaceChildren(...entries.filter(e => (!e.source || pref(e.id).managed !== false) && pref(e.id).pinned).map(e => actionButton(e, true)));
  }
  function buildPanel() {
    backdrop = el('div'); backdrop.id = 'nh-backdrop'; backdrop.hidden = true;
    backdrop.addEventListener('click', () => setOpen(false, true));
    panel = el('section'); panel.id = 'nh-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'nh-title');
    const header = el('div', 'nh-heading'); heading = el('strong', '', 'Plugins'); heading.id = 'nh-title';
    const configure = button('⚙', 'nh-control', () => { settings = !settings; render(); });
    configure.setAttribute('aria-label', 'Toggle plugin settings');
    closeButton = button('✕', 'nh-control', () => setOpen(false, true)); closeButton.setAttribute('aria-label', 'Close plugins');
    header.append(heading, configure, closeButton);
    content = el('div', 'nh-content'); errorBox = el('div', 'nh-error'); errorBox.setAttribute('role', 'alert');
    panel.append(header, content, errorBox); document.body.append(backdrop, panel);
    document.addEventListener('keydown', event => {
      if (!open) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false, true); }
      if (event.key === 'Tab') {
        const nodes = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    }, true);
    window.addEventListener('resize', () => { panel.style.top = ''; panel.style.right = ''; position(); });
    document.addEventListener('focusin', event => { if (open && !panel.contains(event.target)) closeButton.focus(); });
    window.addEventListener('popstate', () => setOpen(false));
  }
  function sync(force = false) {
    scheduled = false;
    const nav = document.querySelector('nav.top-nav');
    const target = nav?.querySelector('.navbar-buttons');
    const refract = document.body.classList.contains('stash-liquid-glass');
    const dock = target && usesRefractDock() ? document.querySelector('.refract-mobile-dock') : null;
    const burger = dock?.querySelector(':scope > .refract-dock-burger');
    mountRefractTrigger(burger);
    if (!target) {
      host?.remove();
      syncHidden(managed, new Set(), 'nh-managed');
      syncHidden(utilities, new Set(), 'nh-mobile-utility');
      syncHidden(refractMirrors, new Set(), 'nh-refract-mirror');
      if (open) setOpen(false);
      return;
    }
    if (!host?.isConnected || host.parentElement !== target) {
      host?.remove(); host = el('div'); host.id = 'nh-host';
      pins = el('div', 'nh-pins');
      trigger = menuTrigger('▦ Plugins', 'nh-trigger', () => setOpen(!open));
      host.append(pins, trigger); target.prepend(host); force = true;
    }
    if (open && !activeTrigger()) setOpen(false);
    // Stash already exposes these utilities in its collapsed main menu.
    // Hide a mobile duplicate only after finding its counterpart there.
    const duplicateUtilities = new Set();
    const collapse = refract ? null : nav.querySelector('.navbar-collapse');
    const counterparts = collapse?.querySelectorAll('.nav-utility') || [];
    for (const node of target.querySelectorAll(':scope > .nav-utility')) {
      const href = node.getAttribute('href');
      const title = node.getAttribute('title');
      const duplicate = [...counterparts].some(other =>
        (href && other.getAttribute('href') === href) || (title && other.tagName === node.tagName && other.getAttribute('title') === title));
      if (duplicate) duplicateUtilities.add(node);
      else if (node.classList.contains('nh-mobile-utility')) node.classList.remove('nh-mobile-utility');
    }
    syncHidden(utilities, duplicateUtilities, 'nh-mobile-utility');
    const definitions = new Map(builtins.map(def => [def.id, def]));
    registry.forEach((def, id) => definitions.set(id, def));
    const next = [];
    definitions.forEach(def => {
      const source = sourceFor(def, nav);
      if (source || def.onClick) next.push({ ...def, source });
    });
    next.sort((a, b) => (pref(a.id).order ?? 1000) - (pref(b.id).order ?? 1000));
    // Do not remove/re-add classes each scan: that would trigger an observer loop.
    const shouldHide = new Set();
    const sources = new Set();
    next.forEach(entry => {
      if (!entry.source || pref(entry.id).managed === false) return;
      // Hide the SFW wrapper as well, to avoid its margin leaving an empty gap.
      const node = entry.source.id === 'plugin_sfw' && entry.source.parentElement?.matches('a') ? entry.source.parentElement : entry.source;
      if (activeTrigger()) {
        shouldHide.add(node);
        sources.add(entry.source);
      } else if (node.classList.contains('nh-managed')) {
        node.classList.remove('nh-managed');
      }
    });
    syncHidden(managed, shouldHide, 'nh-managed');
    syncHidden(refractMirrors, findRefractMirrors(nav, burger && dock, sources), 'nh-refract-mirror');
    const nextSignature = JSON.stringify(next.map(e => [e.id,e.label,e.icon,state(e),e.source?.innerHTML,e.source?.title,pref(e.id)]));
    const replaced = next.some((entry, index) => entry.source !== entries[index]?.source || entry.onClick !== entries[index]?.onClick);
    entries = next;
    if (force || replaced || signature !== nextSignature) { signature = nextSignature; render(); }
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(() => sync(), 32); } }
  window.NavHub = Object.freeze({
    version:'0.1.0',
    register(definition) {
      if (!definition || typeof definition.id !== 'string' || !/^[a-z0-9_-]+$/i.test(definition.id) || typeof definition.label !== 'string' || !definition.label.trim()) throw new TypeError('NavHub: id and label are required.');
      if (typeof definition.onClick !== 'function' && typeof definition.selector !== 'string') throw new TypeError('NavHub: provide onClick or selector.');
      if (definition.selector) document.createDocumentFragment().querySelector(definition.selector); // validate selector before saving
      const def = { ...definition }; registry.set(def.id, def); schedule();
      return () => { if (registry.get(def.id) === def) { registry.delete(def.id); schedule(); } };
    },
    refresh: schedule,
    open() { if (panel && activeTrigger()) setOpen(true); },
    close() { if (panel) setOpen(false, true); }
  });
  function start() {
    buildPanel(); sync();
    refractMobile.addEventListener('change', schedule);
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        const node = record.target;
        return !panel.contains(node) && !backdrop.contains(node) && !host?.contains(node);
      })) schedule();
    });
    observer.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class','disabled','aria-disabled','aria-pressed','title','href','style'], characterData:true });
    window.dispatchEvent(new CustomEvent('navhub:ready', { detail:window.NavHub }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true }); else start();
})();



