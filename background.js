// Service worker: settings defaults, opening PDFs in the OpenDyslexic viewer,
// the right-click menu and the keyboard shortcut.

const DEFAULTS = { enabled: true, disabledSites: [], keepCode: true, pdfAutoOpen: true };
const VIEWER = chrome.runtime.getURL("viewer/viewer.html");

export function viewerUrl(pdfUrl) {
  return `${VIEWER}?file=${encodeURIComponent(pdfUrl)}`;
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// URLs the user asked to see in Brave's own viewer ("Show original"); the next
// navigation to each is let through once instead of being redirected.
async function consumeBypass(url) {
  const { bypass = [] } = await chrome.storage.session.get("bypass");
  const i = bypass.indexOf(url);
  if (i === -1) return false;
  bypass.splice(i, 1);
  await chrome.storage.session.set({ bypass });
  return true;
}

async function addBypass(url) {
  const { bypass = [] } = await chrome.storage.session.get("bypass");
  bypass.push(url);
  await chrome.storage.session.set({ bypass: bypass.slice(-20) });
}

async function redirectToViewer(tabId, url) {
  const settings = await getSettings();
  if (!settings.pdfAutoOpen) return;
  if (await consumeBypass(url)) return;
  chrome.tabs.update(tabId, { url: viewerUrl(url) });
}

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value.toLowerCase() : "";
}

// Web PDFs: recognised by the Content-Type the server sends, so links that
// don't end in .pdf are caught too. Downloads (Content-Disposition: attachment)
// and POST results (which can't be fetched again) are left alone.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.method !== "GET") return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const type = header(details.responseHeaders, "content-type");
    const disposition = header(details.responseHeaders, "content-disposition");
    const isPdf =
      type.startsWith("application/pdf") ||
      (type.startsWith("application/octet-stream") && /\.pdf($|[?#])/i.test(details.url));
    if (!isPdf || disposition.startsWith("attachment")) return;
    redirectToViewer(details.tabId, details.url);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"]
);

// PDFs opened from disk (file://). These need "Allow access to file URLs"
// switched on for the extension in brave://extensions.
chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    redirectToViewer(details.tabId, details.url);
  },
  { url: [{ schemes: ["file"], pathSuffix: ".pdf" }, { schemes: ["file"], pathSuffix: ".PDF" }] }
);

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...stored });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "open-pdf-link",
      title: "Open PDF in OpenDyslexic",
      contexts: ["link"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-pdf-link" && info.linkUrl) {
    chrome.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "bypass" && msg.url) {
    addBypass(msg.url).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-site" || !tab?.url) return;
  let host;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return;
  }
  if (!host) return;
  const { disabledSites } = await getSettings();
  const next = disabledSites.includes(host)
    ? disabledSites.filter((h) => h !== host)
    : [...disabledSites, host];
  await chrome.storage.sync.set({ disabledSites: next });
});
