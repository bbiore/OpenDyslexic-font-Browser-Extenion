# OpenDyslexic Everywhere (Brave extension)

Shows the readable text on every website in the OpenDyslexic font, and opens
PDFs in a viewer that shows their text in OpenDyslexic too.

## Install in Brave

1. Unzip `opendyslexic-extension.zip` somewhere you'll keep it (Brave loads the
   extension from that folder, so don't delete it afterwards).
2. Open `brave://extensions` in the address bar.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped `opendyslexic-extension`
   folder (the one that contains `manifest.json`).
5. Optional, for PDFs saved on your computer: click **Details** under
   OpenDyslexic Everywhere and turn on **Allow access to file URLs**.
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to
   OpenDyslexic.

Reload any tabs that were already open so the font applies to them.

## Using it

**Websites.** On by default for every site. Click the toolbar icon to:
- turn it off everywhere (**Websites**),
- turn it off just for the current site (**This site**),
- keep code blocks in their normal font (**More options**).

Shortcut: **Alt+Shift+D** turns it on or off for the current site. You can
change the shortcut at `brave://extensions/shortcuts`.

Icon fonts (Font Awesome, Material Icons and similar) are left alone so
buttons and icons keep working.

**PDFs.** With the **PDFs** switch on (the default), any PDF you open in Brave
opens in the OpenDyslexic viewer instead of Brave's own. Turn the switch off to
go back to Brave's viewer. You can also:
- right-click a PDF link and choose **Open PDF in OpenDyslexic**,
- click **Open a PDF from your computer** in the popup, or drag a PDF onto the
  viewer.

The viewer has three modes along the top (keys **D**, **R**, **O**):
- **OpenDyslexic**: the pages as printed, with pictures, tables and colours
  kept, and every piece of text redrawn in OpenDyslexic in the same spot.
  Long lines are squeezed a little so they still fit.
- **Reading view**: just the text, reflowed into paragraphs in OpenDyslexic,
  with text size, line spacing and background colour you can change. Best for
  reading long documents.
- **Original**: the PDF untouched, for comparing.

Text can still be selected, copied and searched with Ctrl+F. **Save**
downloads the original PDF and **Brave viewer** reopens it in Brave's own
viewer.

## Limits

- Scanned PDFs that are only pictures of text have no text to change. If the
  scan has hidden OCR text, that text is drawn in OpenDyslexic over the scan.
- Pages that draw text into a canvas (Google Docs' editor, some games) can't be
  changed.
- PDFs behind a login usually work, but if one won't load, use the **Brave
  viewer** button.
- Brave may warn that developer-mode extensions are enabled; that's expected
  for extensions loaded this way.

## What's inside

| Path | What it is |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3) |
| `content/` | Swaps the font on web pages |
| `background.js` | Opens PDFs in the viewer, right-click menu, shortcut |
| `popup/` | The toolbar popup |
| `viewer/` | The PDF viewer |
| `fonts/` | OpenDyslexic 0.990 by Abbie Gonzalez, SIL Open Font License 1.1 (`fonts/OFL.txt`) |
| `lib/pdfjs/` | Mozilla PDF.js 6.4 (legacy build), Apache License 2.0 (`lib/pdfjs/LICENSE`) |

Nothing is sent anywhere: settings are stored in Brave's extension storage and
PDFs are processed inside the browser.
