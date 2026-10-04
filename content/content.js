// Swaps readable text on the page to OpenDyslexic.
//
// Rather than forcing the font on every element with one blanket rule (which
// breaks icon fonts such as Font Awesome or Material Icons, and code blocks),
// each element is checked once: its computed font is read, and only elements
// whose font is safe to replace get a data-odx attribute. content.css then
// applies the font to [data-odx] while <html> carries data-odx-on.

(() => {
  "use strict";

  if (window.__odxLoaded) return;
  window.__odxLoaded = true;

  const DEFAULTS = { enabled: true, disabledSites: [], keepCode: true };
  const MARK = "data-odx";
  const ROOT_FLAG = "data-odx-on";
  const FAMILY = "OpenDyslexic Ext";

  // First font in the stack looks like an icon font.
  const ICON_FONT =
    /icon|awesome|material|glyph|symbol|fontello|icomoon|dashicon|octicon|codicon|feather|lucide|tabler|remix|phosphor|bootstrap-icons|genericons|entypo|typicons|foundation-icons|webfont|fabric mdl2|segoe (mdl2|fluent)|wingdings|webdings/i;
  // First font in the stack looks like a monospace / code font.
  const MONO_FONT =
    /mono|courier|consolas|menlo|monaco|inconsolata|fira code|source code|hack\b|lucida console|ubuntu mono|cascadia|iosevka|andale|pt mono|roboto mono|jetbrains/i;
  // Private Use Area characters are what icon fonts map their glyphs to.
  const PUA = /[-]|\uDB80[\uDC00-\uDFFF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "TITLE", "HEAD",
    "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "BR", "HR", "WBR", "SOURCE", "TRACK", "MATH",
  ]);
  const CODE_TAGS = new Set(["CODE", "PRE", "KBD", "SAMP", "TT", "VAR"]);
  const SVG_NS = "http://www.w3.org/2000/svg";

  let settings = { ...DEFAULTS };
  let active = false;
  let observer = null;
  const shadowStyles = new Set();
  const observedRoots = new WeakSet();

  // Queued work, flushed once per animation frame so large pages and
  // single-page apps are processed in batches (all reads, then all writes).
  const pendingTrees = new Set();
  const pendingRecheck = new Set();
  let flushScheduled = false;

  function siteKey() {
    try {
      return window.top.location.hostname || location.hostname;
    } catch {
      return location.hostname;
    }
  }

  function shouldBeActive() {
    return settings.enabled && !settings.disabledSites.includes(siteKey());
  }

  function firstFamily(fontFamily) {
    const first = fontFamily.split(",")[0] || "";
    return first.trim().replace(/^["']|["']$/g, "");
  }

  function isCodeElement(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (CODE_TAGS.has(n.tagName)) return true;
    }
    return false;
  }

  function ownText(el) {
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.data;
    }
    return text;
  }

  // Decide from the element's current computed font whether OpenDyslexic may
  // replace it. Must be called while the element is not yet marked.
  function isReplaceable(el, style) {
    // Never set our font on an element the page has hidden from screen readers
    // and that holds no real words: almost always a decorative icon.
    if (el.getAttribute("aria-hidden") === "true" && ownText(el).trim().length <= 2) return false;
    const fam = style.fontFamily || "";
    const first = firstFamily(fam);
    if (first === FAMILY) return true; // already inherits our font from a marked parent
    if (ICON_FONT.test(first)) return false;
    if (settings.keepCode) {
      if (MONO_FONT.test(first) || /(^|,)\s*monospace\s*$/i.test(fam)) return false;
      if (isCodeElement(el)) return false;
    }
    // Ligature icon fonts ("home", "search") and PUA glyphs.
    const text = ownText(el);
    if (text && PUA.test(text)) return false;
    if (typeof el.className === "string" && /\bmaterial-(icons|symbols)/.test(el.className)) return false;
    return true;
  }

  function candidates(root, out) {
    if (root.nodeType === 1) collect(root, out);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (SKIP_TAGS.has(n.tagName) || n.namespaceURI === SVG_NS) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      collect(n, out);
      n = walker.nextNode();
    }
  }

  function collect(el, out) {
    if (SKIP_TAGS.has(el.tagName) || el.namespaceURI === SVG_NS) return;
    if (!el.hasAttribute(MARK)) out.push(el);
    if (el.shadowRoot) attachShadow(el.shadowRoot);
  }

  // Open shadow roots (web components) don't see page CSS, so each one gets
  // its own copy of the rule and its own observer.
  function attachShadow(shadow) {
    if (observedRoots.has(shadow)) return;
    observedRoots.add(shadow);
    const style = document.createElement("style");
    style.textContent = `[${MARK}]{font-family:"${FAMILY}",system-ui,sans-serif !important}`;
    style.disabled = !active;
    shadow.appendChild(style);
    shadowStyles.add(style);
    if (observer) observer.observe(shadow, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    pendingTrees.add(shadow);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushScheduled || !active) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
  }

  function flush() {
    flushScheduled = false;
    if (!active) return;

    // Elements whose class changed: drop the mark so the read below sees the
    // site's own font again (e.g. an element that just became an icon).
    const recheck = [...pendingRecheck];
    pendingRecheck.clear();
    for (const el of recheck) el.removeAttribute(MARK);

    const els = recheck.filter((el) => el.isConnected);
    for (const root of pendingTrees) {
      if (root.isConnected !== false) candidates(root, els);
    }
    pendingTrees.clear();

    // Read phase, then write phase, so the browser restyles once per batch.
    const toMark = [];
    for (const el of els) {
      if (el.hasAttribute(MARK)) continue;
      if (isReplaceable(el, getComputedStyle(el))) toMark.push(el);
    }
    for (const el of toMark) el.setAttribute(MARK, "");
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) pendingTrees.add(node);
          else if (node.nodeType === 3 && node.parentElement) pendingRecheck.add(node.parentElement);
        }
      } else if (m.type === "attributes" && m.target.nodeType === 1) {
        pendingRecheck.add(m.target);
      }
    }
    scheduleFlush();
  }

  function start() {
    if (active) return;
    active = true;
    document.documentElement.setAttribute(ROOT_FLAG, "");
    for (const s of shadowStyles) s.disabled = false;
    if (!observer) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["class"],
      });
    }
    pendingTrees.add(document.documentElement);
    scheduleFlush();
    // Custom elements often attach their shadow root after insertion; sweep
    // again once the page has settled.
    setTimeout(rescanShadowHosts, 1500);
    setTimeout(rescanShadowHosts, 5000);
  }

  function stop() {
    if (!active) return;
    active = false;
    document.documentElement.removeAttribute(ROOT_FLAG);
    for (const s of shadowStyles) s.disabled = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Keep existing marks: with data-odx-on gone they have no effect, and
    // turning back on is then instant. New content is caught by a fresh scan.
  }

  function rescanShadowHosts() {
    if (!active) return;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot && !observedRoots.has(n.shadowRoot)) attachShadow(n.shadowRoot);
    }
  }

  function apply() {
    if (shouldBeActive()) start();
    else stop();
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
    if (changes.keepCode && active) {
      // Re-evaluate everything under the new code setting.
      stop();
      for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK);
    }
    apply();
  });

  // Lets the popup ask whether this page is currently using the font.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "odx-status" && window === window.top) {
      sendResponse({ active, site: siteKey() });
    }
  });
})();
