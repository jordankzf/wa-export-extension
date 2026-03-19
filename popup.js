const startBtn = document.getElementById("start");
const status = document.getElementById("status");
const log = document.getElementById("log");
const bar = document.getElementById("bar");

function addLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

// Restore state on popup open
(async () => {
  const data = await chrome.storage.local.get(["waExportLog", "waExportStatus", "waExportProgress"]);

  // Restore log
  if (data.waExportLog) {
    log.textContent = data.waExportLog.join("\n") + "\n";
    log.scrollTop = log.scrollHeight;
  }

  // Restore status/progress
  if (data.waExportStatus) {
    const s = data.waExportStatus;
    if (s.type === "progress") {
      const pct = Math.round((s.done / s.total) * 100);
      bar.style.width = pct + "%";
      status.textContent = `${s.done}/${s.total} conversations (${pct}%)`;
    } else if (s.type === "done") {
      status.textContent = "Export complete!";
    } else if (s.type === "error") {
      status.textContent = "Error: " + s.text;
    }
  }

  if (data.waExportProgress && data.waExportProgress.completedChats.length > 0) {
    status.textContent = `${data.waExportProgress.completedChats.length} chats done (resume available)`;
  }
})();

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  status.textContent = "Finding WhatsApp tab…";

  const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (!tab) {
    status.textContent = "No WhatsApp tab found! Open web.whatsapp.com first.";
    startBtn.disabled = false;
    return;
  }

  status.textContent = "Starting export…";
  addLog("Sending start command to background…");
  chrome.runtime.sendMessage({ action: "startExport", tabId: tab.id });
});

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["waExportProgress", "waExportLog", "waExportStatus"]);
  log.textContent = "";
  bar.style.width = "0%";
  status.textContent = "Progress cleared.";
});

// Listen for live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "log") addLog(msg.text);
  if (msg.type === "status") status.textContent = msg.text;
  if (msg.type === "progress") {
    const pct = Math.round((msg.done / msg.total) * 100);
    bar.style.width = pct + "%";
    status.textContent = `${msg.done}/${msg.total} conversations (${pct}%)`;
  }
  if (msg.type === "done") {
    status.textContent = "Export complete!";
    startBtn.disabled = false;
  }
  if (msg.type === "error") {
    status.textContent = "Error: " + msg.text;
    startBtn.disabled = false;
  }
});
