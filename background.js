// WhatsApp Export - Background Script
// Uses chrome.debugger for real mouse clicks (works with React)
// Uses Runtime.evaluate for DOM queries and scrolling

let tabId = null;
let logLines = [];

// ─── CDP Helpers ──────────────────────────────────────────────────────────────

function cdp(method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(expr) {
  const result = await cdp("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "JS eval error");
  }
  return result.result.value;
}

async function realClick(x, y) {
  const opts = { x, y, button: "left", clickCount: 1 };
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...opts });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...opts });
}

async function pressKey(key) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function notify(msg) {
  if (msg.type === "log") {
    console.log("[WA]", msg.text);
    logLines.push(msg.text);
    // Keep last 200 lines
    if (logLines.length > 200) logLines = logLines.slice(-200);
    await chrome.storage.local.set({ waExportLog: logLines }).catch(() => {});
  }
  if (msg.type === "progress" || msg.type === "done" || msg.type === "error") {
    await chrome.storage.local.set({ waExportStatus: msg }).catch(() => {});
  }
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Load/Save Progress ──────────────────────────────────────────────────────

async function loadProgress() {
  const data = await chrome.storage.local.get("waExportProgress");
  return data.waExportProgress || { completedChats: [], markdown: "" };
}

async function saveProgress(progress) {
  await chrome.storage.local.set({ waExportProgress: progress });
}

// ─── Periodic markdown save to disk ──────────────────────────────────────────

async function saveMarkdownToDisk(markdown) {
  try {
    const dataUrl = "data:text/markdown;base64," + btoa(unescape(encodeURIComponent(markdown)));
    await chrome.downloads.download({
      url: dataUrl,
      filename: "whatsapp-export.md",
      conflictAction: "overwrite",
    });
  } catch (e) {
    console.log("[WA] disk save error:", e.message);
  }
}

// ─── Collect All Chat Names ──────────────────────────────────────────────────

async function collectAllChatNames() {
  await notify({ type: "log", text: "Collecting chat names…" });

  await evaluate(`document.querySelector('#pane-side').scrollTop = 0`);
  await sleep(500);

  const seen = new Set();
  const allNames = [];
  let noNew = 0;

  for (let i = 0; i < 600; i++) {
    const names = await evaluate(`
      (() => {
        const out = [];
        const rows = document.querySelectorAll('[role="row"]');
        for (const row of rows) {
          const outer = row.querySelector('[role="gridcell"]');
          if (!outer) continue;
          const inners = outer.querySelectorAll('[role="gridcell"]');
          for (const cell of inners) {
            const s = cell.querySelector('span[title]');
            if (s) { out.push(s.getAttribute('title')); break; }
          }
        }
        return out;
      })()
    `);

    let added = 0;
    for (const n of names) {
      if (n && !seen.has(n)) {
        seen.add(n);
        allNames.push(n);
        added++;
      }
    }

    if (added === 0) {
      noNew++;
      if (noNew >= 25) break;
    } else {
      noNew = 0;
    }

    if (i % 30 === 0) {
      const info = await evaluate(`
        (() => {
          const p = document.querySelector('#pane-side');
          return { top: Math.round(p.scrollTop), height: p.scrollHeight, client: p.clientHeight };
        })()
      `);
      await notify({ type: "log", text: `  scroll ${i}: ${seen.size} chats, scrollTop=${info.top}/${info.height}` });
    }

    await evaluate(`document.querySelector('#pane-side').scrollBy(0, 200)`);
    await sleep(350);

    const nearBottom = await evaluate(`
      (() => {
        const p = document.querySelector('#pane-side');
        return p.scrollTop + p.clientHeight >= p.scrollHeight - 20;
      })()
    `);
    if (nearBottom) {
      await sleep(2000);
      await evaluate(`document.querySelector('#pane-side').scrollBy(0, 50)`);
      await sleep(1000);
    }
  }

  // Scroll back to top
  await evaluate(`document.querySelector('#pane-side').scrollTop = 0`);
  await sleep(300);

  await notify({ type: "log", text: `Found ${allNames.length} chats.` });
  return allNames;
}

// ─── Open a Chat ─────────────────────────────────────────────────────────────
// Scrolls sidebar from CURRENT position (not top) to find the chat, then clicks

async function openChat(chatName, lastIndex) {
  const escaped = JSON.stringify(chatName);

  // First check if already visible without scrolling
  for (let attempt = 0; attempt < 400; attempt++) {
    const found = await evaluate(`
      (() => {
        const rows = document.querySelectorAll('[role="row"]');
        for (const row of rows) {
          const outer = row.querySelector('[role="gridcell"]');
          if (!outer) continue;
          const inners = outer.querySelectorAll('[role="gridcell"]');
          for (const cell of inners) {
            const s = cell.querySelector('span[title]');
            if (s && s.getAttribute('title') === ${escaped}) {
              row.scrollIntoView({ block: 'center', behavior: 'instant' });
              return true;
            }
          }
        }
        return false;
      })()
    `);

    if (found) {
      await sleep(300);
      const coords = await evaluate(`
        (() => {
          const rows = document.querySelectorAll('[role="row"]');
          for (const row of rows) {
            const outer = row.querySelector('[role="gridcell"]');
            if (!outer) continue;
            const inners = outer.querySelectorAll('[role="gridcell"]');
            for (const cell of inners) {
              const s = cell.querySelector('span[title]');
              if (s && s.getAttribute('title') === ${escaped}) {
                const rect = row.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
            }
          }
          return null;
        })()
      `);

      if (coords && coords.y > 0 && coords.y < 5000) {
        await realClick(coords.x, coords.y);
        await sleep(2500);

        // Verify conversation opened
        for (let w = 0; w < 5; w++) {
          const check = await evaluate(`
            (() => {
              const msgs = document.querySelectorAll('[data-id]');
              const input = document.querySelector('[contenteditable="true"][data-tab]');
              return { msgs: msgs.length, input: !!input };
            })()
          `);
          if (check.msgs > 0 || check.input) return true;
          await sleep(800);
        }
        // Retry click once
        await realClick(coords.x, coords.y);
        await sleep(2000);
        const recheck = await evaluate(`
          document.querySelectorAll('[data-id]').length > 0 || !!document.querySelector('[contenteditable="true"][data-tab]')
        `);
        if (recheck) return true;
      }
    }

    // Scroll sidebar down to find it
    await evaluate(`document.querySelector('#pane-side').scrollBy(0, 200)`);
    await sleep(250);
  }
  return false;
}

// ─── Extract Messages ────────────────────────────────────────────────────────

async function extractConversation() {
  // Find message container by walking up from a [data-id] element
  const diag = await evaluate(`
    (() => {
      const msgs = document.querySelectorAll('[data-id]');
      const input = document.querySelector('[contenteditable="true"][data-tab]');
      let sc = null;
      if (msgs.length > 0) {
        let el = msgs[0].parentElement;
        while (el) {
          const s = getComputedStyle(el);
          if (s.overflowY === 'auto' || s.overflowY === 'scroll') { sc = el; break; }
          el = el.parentElement;
        }
      }
      if (sc) window.__mc = sc;
      return { msgCount: msgs.length, hasInput: !!input, hasContainer: !!sc, h: sc ? sc.scrollHeight : 0 };
    })()
  `);

  await notify({ type: "log", text: `  diag: ${diag.msgCount} msgs, input=${diag.hasInput}, container=${diag.hasContainer}, h=${diag.h}` });

  if (diag.msgCount === 0) return [];

  // Scroll to top to load full history
  let prevH = 0, stalls = 0;
  for (let i = 0; i < 1500; i++) {
    const h = await evaluate(`(() => { const c = window.__mc; if (!c) return -1; c.scrollTop = 0; return c.scrollHeight; })()`);
    if (h === -1) break;
    if (h === prevH) { stalls++; if (stalls >= 12) break; }
    else { stalls = 0; prevH = h; }
    await sleep(350);
  }

  await sleep(400);
  await evaluate(`if(window.__mc) window.__mc.scrollTop = 0`);
  await sleep(400);

  // Extract messages by scrolling top to bottom
  const messages = await evaluate(`
    (async () => {
      const c = window.__mc;
      if (!c) return [];
      const all = [];
      const seenIds = new Set();
      let noNew = 0;

      for (let iter = 0; iter < 2000; iter++) {
        const msgEls = c.querySelectorAll('[data-id]');
        let added = 0;

        for (const msgEl of msgEls) {
          const dataId = msgEl.getAttribute('data-id') || '';
          if (seenIds.has(dataId)) continue;
          seenIds.add(dataId);
          added++;

          const preEl = msgEl.querySelector('[data-pre-plain-text]');
          const pre = preEl?.getAttribute('data-pre-plain-text') || '';
          const text = msgEl.querySelector('[data-testid="selectable-text"]')?.textContent || '';
          const isOut = dataId.startsWith('true_');

          const hasImg = !!(msgEl.querySelector('img[src*="blob"]') || msgEl.querySelector('img[src*="media"]') || msgEl.querySelector('img[draggable]'));
          const hasVideo = !!msgEl.querySelector('video');
          const hasPtt = !!msgEl.querySelector('[data-testid="ptt-play"]');
          const hasAudio = !!msgEl.querySelector('[data-testid="audio-play"]');
          const hasDoc = !!msgEl.querySelector('[data-testid="document-thumb"]');
          const hasSticker = !!msgEl.querySelector('img[data-testid="sticker"]');

          let content = text;
          if (!content) {
            if (hasSticker) content = '[sticker]';
            else if (hasVideo) content = '[video]';
            else if (hasPtt || hasAudio) content = '[voice note]';
            else if (hasDoc) content = '[document]';
            else if (hasImg) content = '[image]';
            else content = '[media]';
          } else if (hasImg) content = '[image] ' + content;
          else if (hasVideo) content = '[video] ' + content;
          else if (hasDoc) content = '[document] ' + content;

          let date = '';
          let prev = msgEl.closest('[role="row"]')?.previousElementSibling;
          while (prev) {
            if (!prev.querySelector('[data-id]')) {
              const txt = prev.textContent?.trim() || '';
              if (txt && txt.length < 40 && !txt.includes('end-to-end')) { date = txt; break; }
            }
            prev = prev.previousElementSibling;
          }

          all.push({ pre, content, isOut, date });
        }

        const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 50;
        if (atBottom) break;
        if (added === 0) { noNew++; if (noNew >= 15) break; }
        else noNew = 0;

        c.scrollBy(0, Math.floor(c.clientHeight * 0.7));
        await new Promise(r => setTimeout(r, 250));
      }
      return all;
    })()
  `);

  return messages || [];
}

// ─── Format Markdown ─────────────────────────────────────────────────────────

function formatChat(name, messages) {
  let md = `\n## ${name}\n*${messages.length} messages*\n`;
  let curDate = "";

  for (const msg of messages) {
    const m = (msg.pre || "").match(
      /^\[(\d{1,2}:\d{2}\s*[APap][Mm]),\s*(\d{1,2}\/\d{1,2}\/\d{4})\]\s*(.+?):\s*$/
    );
    const time = m ? m[1] : "";
    const date = m ? m[2] : msg.date || "";
    const sender = m ? m[3] : msg.isOut ? "You" : "Unknown";

    if (date && date !== curDate) {
      curDate = date;
      md += `### ${curDate}\n`;
    }
    const who = msg.isOut ? "**You**" : `**${sender}**`;
    md += `\`${time}\` ${who}: ${msg.content}\n`;
  }

  md += "\n---\n";
  return md;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

async function runExport(tid) {
  tabId = tid;

  // Load previous log lines
  const logData = await chrome.storage.local.get("waExportLog");
  logLines = logData.waExportLog || [];

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await notify({ type: "log", text: "Debugger attached" });
  } catch (e) {
    await notify({ type: "error", text: "Could not attach debugger: " + e.message });
    return;
  }

  try {
    const progress = await loadProgress();
    const doneSet = new Set(progress.completedChats);
    let markdown = progress.markdown || "# WhatsApp Export\n*Exported on " + new Date().toISOString() + "*\n";

    const chatNames = await collectAllChatNames();
    await notify({ type: "progress", done: doneSet.size, total: chatNames.length });

    let scraped = doneSet.size;
    let lastSaveToDisk = Date.now();

    for (let i = 0; i < chatNames.length; i++) {
      const name = chatNames[i];
      if (doneSet.has(name)) continue;

      await notify({ type: "log", text: `[${scraped + 1}/${chatNames.length}] ${name}` });

      const opened = await openChat(name, i);
      if (!opened) {
        await notify({ type: "log", text: `  ⚠ could not open` });
        continue;
      }

      const messages = await extractConversation();
      await notify({ type: "log", text: `  ✓ ${messages.length} messages` });

      markdown += formatChat(name, messages);

      doneSet.add(name);
      progress.completedChats = Array.from(doneSet);
      progress.markdown = markdown;
      await saveProgress(progress);
      scraped++;

      await notify({ type: "progress", done: scraped, total: chatNames.length });

      // Save to disk every 10 chats
      if (scraped % 10 === 0 || Date.now() - lastSaveToDisk > 60000) {
        await notify({ type: "log", text: "  💾 saving to disk…" });
        await saveMarkdownToDisk(markdown);
        lastSaveToDisk = Date.now();
      }

      await pressKey("Escape");
      await sleep(600);
    }

    // Final save
    await saveMarkdownToDisk(markdown);
    await notify({ type: "done" });
    await notify({ type: "log", text: `\nDone! ${scraped} conversations exported.` });
  } catch (e) {
    await notify({ type: "error", text: e.message });
    await notify({ type: "log", text: "Error: " + e.stack });
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "startExport") {
    runExport(msg.tabId);
  }
});
