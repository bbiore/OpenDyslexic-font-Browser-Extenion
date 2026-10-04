// PDF viewer that shows a PDF's text in OpenDyslexic.
//
// Three modes, switched from the toolbar (or D / R / O on the keyboard):
//  - OpenDyslexic: each page is drawn by PDF.js as usual, then every run of
//    text is painted over with its own background colour and redrawn in
//    OpenDyslexic, in the same place, colour, weight and slant. Pictures,
//    tables and layout stay as printed.
//  - Reading view: the text is pulled out and reflowed into paragraphs in
//    OpenDyslexic, with adjustable size, spacing and background.
//  - Original: the PDF untouched, to compare.
// A transparent PDF.js text layer sits on top of the pages so text can still
// be selected, copied and found with Ctrl+F.

import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";

const { getDocument, GlobalWorkerOptions, PasswordResponses, PixelsPerInch, TextLayer, Util } = pdfjsLib;

const LIB = chrome.runtime.getURL("lib/pdfjs/");
GlobalWorkerOptions.workerSrc = `${LIB}pdf.worker.min.mjs`;

const FAMILY = '"OpenDyslexic Ext"';
const CSS_UNITS = PixelsPerInch.PDF_TO_CSS_UNITS;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
// OpenDyslexic glyphs are tall and wide; draw slightly smaller than the
// original text height and squeeze horizontally to fit the original width,
// shrinking a little more rather than squeezing past MIN_SQUEEZE.
const SIZE_RATIO = 0.88;
const MIN_SQUEEZE = 0.8;
const MIN_SIZE_RATIO = 0.6;

const $ = (id) => document.getElementById(id);
const main = $("main");
const pagesEl = $("pages");
const readerEl = $("reader");
const statusEl = $("status");

const prefs = { mode: "od", readerSize: 20, readerLine: "1.8", tint: "cream" };
let pdfDoc = null;
let docName = "document.pdf";
let sourceUrl = null;
let originalBytes = null;
let views = [];
let zoom = 1;
let readerBuiltFor = null;
let renderQueueRunning = false;

const fontsReady = Promise.all(
  ["400", "700", "italic 400", "italic 700"].map((s) => document.fonts.load(`${s} 16px ${FAMILY}`))
);

// ---------------------------------------------------------------- utilities

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function filenameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return name || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function savePrefs() {
  chrome.storage.local.set({ viewerPrefs: prefs });
}

class FileAccessError extends Error {}

function readFileUrl(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () =>
      xhr.response && xhr.response.byteLength ? resolve(xhr.response) : reject(new FileAccessError());
    xhr.onerror = () => reject(new FileAccessError());
    xhr.send();
  });
}

// ------------------------------------------------------------------ loading

async function loadFromUrl(url) {
  sourceUrl = url;
  $("showOriginal").hidden = false;
  docName = filenameFromUrl(url);
  $("docTitle").textContent = docName;
  setStatus("Loading PDF…");
  let data;
  try {
    if (url.startsWith("file:")) {
      data = await readFileUrl(url);
    } else {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`The website answered with error ${res.status}.`);
      data = await res.arrayBuffer();
    }
  } catch (err) {
    if (err instanceof FileAccessError) {
      setStatus(
        "Brave needs your permission to read PDFs saved on your computer.\n" +
          "Open brave://extensions, click Details under OpenDyslexic Everywhere,\n" +
          "and turn on “Allow access to file URLs”. Then reload this tab.",
        true
      );
    } else {
      setStatus(`Couldn't download this PDF. ${err.message || ""}\nTry the Brave viewer button above.`, true);
    }
    return;
  }
  await openData(data);
}

async function openData(data) {
  originalBytes = data;
  $("download").disabled = false;
  $("empty").hidden = true;
  setStatus("Opening PDF…");

  if (pdfDoc) {
    const old = pdfDoc;
    pdfDoc = null;
    old.destroy();
  }
  views = [];
  pagesEl.replaceChildren();
  readerEl.replaceChildren();
  readerBuiltFor = null;

  const task = getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${LIB}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${LIB}standard_fonts/`,
    wasmUrl: `${LIB}wasm/`,
    iccUrl: `${LIB}iccs/`,
    isEvalSupported: false,
  });
  task.onPassword = (update, reason) => {
    const answer = prompt(
      reason === PasswordResponses.INCORRECT_PASSWORD
        ? "That password didn't work. Try again:"
        : "This PDF is protected with a password. Enter it to open the PDF:"
    );
    if (answer === null) task.destroy();
    else update(answer);
  };

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    setStatus(`This file couldn't be opened as a PDF. ${err?.message || ""}`, true);
    return;
  }
  pdfDoc = doc;

  try {
    const meta = await doc.getMetadata();
    const title = meta?.info?.Title?.trim();
    if (title) $("docTitle").textContent = title;
  } catch {}
  document.title = `${$("docTitle").textContent} · OpenDyslexic`;

  for (let num = 1; num <= doc.numPages; num++) {
    const page = await doc.getPage(num);
    if (pdfDoc !== doc) return;
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = String(num);
    const label = document.createElement("span");
    label.className = "pageNum";
    label.textContent = String(num);
    el.append(label);
    pagesEl.append(el);
    views.push({ num, page, el, label, renderedKey: null, visible: false, textContent: null, fontCache: new Map() });
  }

  zoom = fitWidthZoom();
  layoutPages();
  setStatus("");
  if (prefs.mode === "read") buildReader();
}

function fitWidthZoom() {
  if (!views.length) return 1;
  const vp = views[0].page.getViewport({ scale: CSS_UNITS });
  const fit = (main.clientWidth - 48) / vp.width;
  return Math.max(0.5, Math.min(1.5, Math.round(fit * 100) / 100));
}

// ---------------------------------------------------------------- page view

const nearObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const view = views[Number(e.target.dataset.page) - 1];
      if (view) view.visible = e.isIntersecting;
    }
    runRenderQueue();
  },
  { root: main, rootMargin: "1000px 0px" }
);

// Pages far off screen give their canvas memory back.
const farObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const view = views[Number(e.target.dataset.page) - 1];
      if (view && !e.isIntersecting && view.renderedKey) {
        view.el.replaceChildren(view.label);
        view.renderedKey = null;
      }
    }
  },
  { root: main, rootMargin: "5000px 0px" }
);

function layoutPages() {
  $("zoomValue").textContent = `${Math.round(zoom * 100)}%`;
  for (const view of views) {
    const vp = view.page.getViewport({ scale: zoom * CSS_UNITS });
    view.el.style.width = `${vp.width}px`;
    view.el.style.height = `${vp.height}px`;
    nearObserver.unobserve(view.el);
    farObserver.unobserve(view.el);
    nearObserver.observe(view.el);
    farObserver.observe(view.el);
  }
  runRenderQueue();
}

function currentKey() {
  return `${zoom}|${prefs.mode}|${window.devicePixelRatio}`;
}

async function runRenderQueue() {
  if (renderQueueRunning || prefs.mode === "read") return;
  renderQueueRunning = true;
  try {
    for (;;) {
      const key = currentKey();
      const next = views.find((v) => v.visible && v.renderedKey !== key);
      if (!next) break;
      try {
        await renderPage(next, key);
      } catch (err) {
        if (err?.name !== "RenderingCancelledException") console.error(err);
        next.renderedKey = key; // don't retry a broken page forever
      }
    }
  } finally {
    renderQueueRunning = false;
  }
}

async function renderPage(view, key) {
  const doc = pdfDoc;
  const viewport = view.page.getViewport({ scale: zoom * CSS_UNITS });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const ctx = canvas.getContext("2d", { alpha: false });

  await view.page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;
  view.textContent ??= await view.page.getTextContent();
  if (pdfDoc !== doc || currentKey() !== key) return;

  if (prefs.mode === "od") {
    await fontsReady;
    restyleText(ctx, canvas, viewport, dpr, view);
  }

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  view.el.style.setProperty("--page-scale", String(viewport.scale));
  const textLayer = new TextLayer({ textContentSource: view.textContent, container: textLayerDiv, viewport });
  await textLayer.render();
  if (pdfDoc !== doc || currentKey() !== key) return;

  view.el.replaceChildren(canvas, textLayerDiv, view.label);
  view.renderedKey = key;
}

function fontStyleFor(view, fontName) {
  let style = view.fontCache.get(fontName);
  if (style) return style;
  style = { bold: false, italic: false };
  try {
    const font = view.page.commonObjs.get(fontName);
    const name = font?.name || "";
    style.bold = Boolean(font?.bold || font?.black) || /bold|black|heavy|semibold|demi/i.test(name);
    style.italic = Boolean(font?.italic) || /italic|oblique/i.test(name);
  } catch {}
  view.fontCache.set(fontName, style);
  return style;
}

// Paint over each run of text and redraw it in OpenDyslexic.
function restyleText(ctx, canvas, viewport, dpr, view) {
  const { items, styles } = view.textContent;
  const W = canvas.width;
  const H = canvas.height;
  const pixels = ctx.getImageData(0, 0, W, H).data;
  const runs = [];

  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const style = styles[item.fontName] || {};
    if (style.vertical) continue;
    const tx = Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]) * dpr;
    const w = item.width * viewport.scale * dpr;
    if (h < 3 || w < 1) continue;
    let ascent = style.ascent;
    let descent = style.descent;
    if (!ascent) ascent = descent ? 1 + descent : 0.8;
    descent = descent ? -descent : 0.22;
    ascent = Math.min(Math.max(ascent, 0.6), 1.05);
    descent = Math.min(Math.max(descent, 0.1), 0.35);
    const angle = Math.atan2(tx[1], tx[0]);
    const run = {
      str: item.str,
      x: tx[4] * dpr,
      y: tx[5] * dpr,
      angle,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      h,
      w,
      ascent,
      descent,
      font: fontStyleFor(view, item.fontName),
    };
    sampleColours(run, pixels, W, H);
    runs.push(run);
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Cover every original run first, then draw, so neighbours don't clip each other.
  for (const r of runs) {
    const pad = r.h * 0.06;
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.angle);
    ctx.fillStyle = r.bg;
    ctx.fillRect(-pad, -r.h * r.ascent - pad, r.w + 2 * pad, r.h * (r.ascent + r.descent) + 2 * pad);
    ctx.restore();
  }
  ctx.textBaseline = "alphabetic";
  for (const r of runs) {
    const fontPrefix = `${r.font.italic ? "italic " : ""}${r.font.bold ? 700 : 400} `;
    let size = r.h * SIZE_RATIO;
    ctx.font = `${fontPrefix}${size}px ${FAMILY}`;
    let squeeze = r.w / ctx.measureText(r.str).width;
    if (squeeze < MIN_SQUEEZE) {
      size *= Math.max(squeeze / MIN_SQUEEZE, MIN_SIZE_RATIO / SIZE_RATIO);
      ctx.font = `${fontPrefix}${size}px ${FAMILY}`;
      squeeze = r.w / ctx.measureText(r.str).width;
    }
    squeeze = Math.min(squeeze, 1.08);
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.angle);
    ctx.scale(squeeze, 1);
    ctx.fillStyle = r.fg;
    ctx.fillText(r.str, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// Background = the most common colour inside the run's box; text colour =
// the pixel furthest from it (the solid middle of a glyph stroke).
function sampleColours(run, pixels, W, H) {
  const top = -run.h * run.ascent;
  const bottom = run.h * run.descent;
  let stepV = Math.max(1, run.h / 12);
  let stepU = stepV;
  const estimate = (run.w / stepU) * ((bottom - top) / stepV);
  if (estimate > 6000) stepU *= estimate / 6000;

  const counts = new Map();
  const samples = [];
  for (let v = top; v <= bottom; v += stepV) {
    for (let u = 0; u <= run.w; u += stepU) {
      const x = Math.round(run.x + u * run.cos - v * run.sin);
      const y = Math.round(run.y + u * run.sin + v * run.cos);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      samples.push(rgb);
      const q = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
      counts.set(q, (counts.get(q) || 0) + 1);
    }
  }
  if (!samples.length) {
    run.bg = "#ffffff";
    run.fg = "#000000";
    return;
  }

  let bestQ = 0;
  let bestN = -1;
  for (const [q, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestQ = q;
    }
  }
  // Average the actual pixels in the winning bucket for an exact background.
  let br = 0, bgc = 0, bb = 0, bn = 0;
  for (const rgb of samples) {
    const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
    if (((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)) === bestQ) {
      br += r; bgc += g; bb += b; bn++;
    }
  }
  br = Math.round(br / bn);
  bgc = Math.round(bgc / bn);
  bb = Math.round(bb / bn);

  let far = -1;
  let fr = 0, fgc = 0, fb = 0;
  for (const rgb of samples) {
    const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
    const d = (r - br) ** 2 + (g - bgc) ** 2 + (b - bb) ** 2;
    if (d > far) {
      far = d;
      fr = r; fgc = g; fb = b;
    }
  }
  run.bg = `rgb(${br},${bgc},${bb})`;
  if (far < 40 * 40) {
    // No visible ink (e.g. the hidden text layer of a scanned page that has
    // no matching pixels here): use black or white, whichever reads better.
    const lum = 0.299 * br + 0.587 * bgc + 0.114 * bb;
    run.fg = lum > 140 ? "#000000" : "#ffffff";
  } else {
    run.fg = `rgb(${fr},${fgc},${fb})`;
  }
}

// ------------------------------------------------------------- reading view

async function buildReader() {
  if (!pdfDoc || readerBuiltFor === pdfDoc) return;
  const doc = pdfDoc;
  readerBuiltFor = doc;
  readerEl.replaceChildren();
  for (const view of views) {
    view.textContent ??= await view.page.getTextContent();
    if (pdfDoc !== doc) return;
    readerEl.append(pageToHtml(view));
  }
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pageToHtml(view) {
  const vp = view.page.getViewport({ scale: 1 });
  const lines = [];
  let cur = null;

  for (const item of view.textContent.items) {
    if (!("str" in item)) continue;
    if (!item.str) {
      if (item.hasEOL && cur) cur.ended = true;
      continue;
    }
    const tx = Util.transform(vp.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]);
    const x = tx[4];
    const y = tx[5];
    const sameLine = cur && !cur.ended && Math.abs(y - cur.y) <= Math.max(h, cur.h) * 0.5;
    if (!sameLine) {
      cur = { text: "", x0: x, xEnd: x, y, h, ended: false, bold: fontStyleFor(view, item.fontName).bold };
      lines.push(cur);
    } else if (x - cur.xEnd > 0.15 * h && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) {
      cur.text += " ";
    }
    cur.text += item.str;
    cur.xEnd = Math.max(cur.xEnd, x + item.width);
    cur.h = Math.max(cur.h, h);
    if (item.hasEOL) cur.ended = true;
  }

  const section = document.createElement("section");
  section.dataset.page = String(view.num);
  const label = document.createElement("div");
  label.className = "pageLabel";
  label.textContent = `Page ${view.num}`;
  section.append(label);

  const real = lines.filter((l) => l.text.trim());
  if (!real.length) {
    const p = document.createElement("p");
    p.style.opacity = "0.6";
    p.textContent = "(No text on this page. It may be a picture or a scan.)";
    section.append(p);
    return section;
  }

  const bodyHeight = median(real.map((l) => l.h));
  const gaps = [];
  for (let i = 1; i < real.length; i++) {
    const g = real[i].y - real[i - 1].y;
    if (g > 0 && g < bodyHeight * 3) gaps.push(g);
  }
  const lineGap = median(gaps) || bodyHeight * 1.2;
  const typicalWidth = median(real.map((l) => l.xEnd - l.x0));

  const blocks = [];
  let block = null;
  real.forEach((line, i) => {
    const heading = line.h > bodyHeight * 1.2 && line.text.length < 200;
    const prev = real[i - 1];
    let newBlock = !block || heading !== block.heading;
    if (!newBlock && prev) {
      const gap = line.y - prev.y;
      if (gap < 0 || gap > lineGap * 1.45) newBlock = true;
      else if (Math.abs(line.h - prev.h) > bodyHeight * 0.15) newBlock = true;
      else if (!heading && prev.xEnd - prev.x0 < typicalWidth * 0.7 && /[.!?:"”]\s*$/.test(prev.text)) newBlock = true;
    }
    if (newBlock) {
      block = { heading, level: line.h > bodyHeight * 1.6 ? 2 : 3, text: "" };
      blocks.push(block);
    }
    const t = line.text.replace(/\s+/g, " ").trim();
    if (!block.text) block.text = t;
    else if (/[A-Za-z]-$/.test(block.text) && /^[a-z]/.test(t)) block.text = block.text.slice(0, -1) + t;
    else block.text += ` ${t}`;
  });

  for (const b of blocks) {
    const el = document.createElement(b.heading ? `h${b.level}` : "p");
    el.textContent = b.text;
    section.append(el);
  }
  return section;
}

function applyReaderPrefs() {
  document.body.style.setProperty("--reader-size", `${prefs.readerSize}px`);
  document.body.style.setProperty("--reader-line", prefs.readerLine);
  document.body.dataset.tint = prefs.tint;
  $("spacing").value = prefs.readerLine;
  $("tint").value = prefs.tint;
}

// ------------------------------------------------------------------ controls

// Page number at the top of whichever view is showing, to keep your place.
function currentPage() {
  const top = main.getBoundingClientRect().top + 40;
  const selector = prefs.mode === "read" ? "#reader section" : "#pages .page";
  let num = 1;
  for (const el of document.querySelectorAll(selector)) {
    if (el.getBoundingClientRect().top <= top) num = Number(el.dataset.page);
    else break;
  }
  return num;
}

async function setMode(mode) {
  if (mode === prefs.mode) return;
  const page = pdfDoc ? currentPage() : 1;
  prefs.mode = mode;
  document.body.dataset.mode = mode;
  savePrefs();
  if (!pdfDoc) return;
  if (mode === "read") {
    const building = buildReader();
    // Wait until the section for the page you were on exists, then jump to it.
    for (let tries = 0; tries < 200 && !readerEl.querySelector(`section[data-page="${page}"]`); tries++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    readerEl.querySelector(`section[data-page="${page}"]`)?.scrollIntoView();
    await building;
  } else {
    views[page - 1]?.el.scrollIntoView();
    runRenderQueue();
  }
}

function setZoom(next) {
  const page = currentPage();
  const el = views[page - 1]?.el;
  const offset = el ? (main.scrollTop - el.offsetTop) / el.offsetHeight : 0;
  zoom = next;
  layoutPages();
  if (el) main.scrollTop = el.offsetTop + offset * el.offsetHeight;
}

function zoomBy(direction) {
  const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
  let idx = direction > 0 ? (ZOOM_STEPS[i] > zoom + 0.001 ? i : i + 1) : i - 1;
  if (i === -1) idx = direction > 0 ? ZOOM_STEPS.length - 1 : ZOOM_STEPS.length - 2;
  idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx));
  setZoom(ZOOM_STEPS[idx]);
}

for (const btn of document.querySelectorAll("[data-set-mode]")) {
  btn.addEventListener("click", () => setMode(btn.dataset.setMode));
}
$("zoomIn").addEventListener("click", () => zoomBy(1));
$("zoomOut").addEventListener("click", () => zoomBy(-1));
$("textBigger").addEventListener("click", () => {
  prefs.readerSize = Math.min(40, prefs.readerSize + 2);
  applyReaderPrefs();
  savePrefs();
});
$("textSmaller").addEventListener("click", () => {
  prefs.readerSize = Math.max(12, prefs.readerSize - 2);
  applyReaderPrefs();
  savePrefs();
});
$("spacing").addEventListener("change", (e) => {
  prefs.readerLine = e.target.value;
  applyReaderPrefs();
  savePrefs();
});
$("tint").addEventListener("change", (e) => {
  prefs.tint = e.target.value;
  applyReaderPrefs();
  savePrefs();
});

$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  openLocalFile(file);
  e.target.value = "";
});

async function openLocalFile(file) {
  sourceUrl = null;
  $("showOriginal").hidden = true;
  docName = file.name;
  $("docTitle").textContent = file.name;
  history.replaceState(null, "", location.pathname);
  await openData(await file.arrayBuffer());
}

$("download").addEventListener("click", () => {
  if (!originalBytes) return;
  const url = URL.createObjectURL(new Blob([originalBytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = /\.pdf$/i.test(docName) ? docName : `${docName}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$("showOriginal").addEventListener("click", async () => {
  if (!sourceUrl) return;
  await chrome.runtime.sendMessage({ type: "bypass", url: sourceUrl });
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.update(tab.id, { url: sourceUrl });
  else location.href = sourceUrl;
});

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if (k === "d") setMode("od");
  else if (k === "r") setMode("read");
  else if (k === "o") setMode("original");
  else if ((k === "+" || k === "=") && prefs.mode !== "read") zoomBy(1);
  else if (k === "-" && prefs.mode !== "read") zoomBy(-1);
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = [...(e.dataTransfer?.files || [])].find((f) => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (file) openLocalFile(file);
});

// Re-render at the new sharpness if the window moves to another screen.
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.("change", () => runRenderQueue());

// -------------------------------------------------------------------- start

const stored = await chrome.storage.local.get("viewerPrefs");
Object.assign(prefs, stored.viewerPrefs || {});
document.body.dataset.mode = prefs.mode;
applyReaderPrefs();

const file = new URLSearchParams(location.search).get("file");
if (file) loadFromUrl(file);
else $("empty").hidden = false;
