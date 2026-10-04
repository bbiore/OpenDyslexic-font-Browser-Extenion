const DEFAULTS = { enabled: true, disabledSites: [], keepCode: true, pdfAutoOpen: true };
const VIEWER = chrome.runtime.getURL("viewer/viewer.html");

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabUrl = tab?.url || "";
let settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

let host = "";
try {
  const u = new URL(tabUrl);
  if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname;
} catch {}

function render() {
  $("enabled").checked = settings.enabled;
  $("pdfAutoOpen").checked = settings.pdfAutoOpen;
  $("keepCode").checked = settings.keepCode;

  const siteUsable = settings.enabled && host;
  $("siteName").textContent = host || "Not available on this page";
  $("site").checked = Boolean(host) && settings.enabled && !settings.disabledSites.includes(host);
  $("site").disabled = !siteUsable;
  $("siteRow").classList.toggle("disabled", !siteUsable);
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
  render();
}

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("pdfAutoOpen").addEventListener("change", (e) => save({ pdfAutoOpen: e.target.checked }));
$("keepCode").addEventListener("change", (e) => save({ keepCode: e.target.checked }));
$("site").addEventListener("change", (e) => {
  const others = settings.disabledSites.filter((h) => h !== host);
  save({ disabledSites: e.target.checked ? others : [...others, host] });
});

// The PDF button adapts to the current tab.
const inViewer = tabUrl.startsWith(VIEWER);
const viewerFile = inViewer ? new URL(tabUrl).searchParams.get("file") : null;
const looksLikePdf = /^(https?|file):/.test(tabUrl) && /\.pdf($|[?#])/i.test(tabUrl);
const pdfButton = $("pdfAction");

if (inViewer && viewerFile) {
  pdfButton.textContent = "Show this PDF in its original font";
  pdfButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "bypass", url: viewerFile });
    await chrome.tabs.update(tab.id, { url: viewerFile });
    window.close();
  });
} else if (looksLikePdf) {
  pdfButton.textContent = "Open this PDF in OpenDyslexic";
  pdfButton.addEventListener("click", async () => {
    await chrome.tabs.update(tab.id, { url: `${VIEWER}?file=${encodeURIComponent(tabUrl)}` });
    window.close();
  });
} else {
  pdfButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: VIEWER });
    window.close();
  });
}

render();
