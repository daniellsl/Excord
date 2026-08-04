const state = {
  tabId: null,
  mode: "unread",
  running: false,
  paused: false
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  refreshContext: document.querySelector("#refreshContext"),
  tabs: [...document.querySelectorAll(".tab")],
  panels: [...document.querySelectorAll(".panel")],
  serverSelect: document.querySelector("#serverSelect"),
  unreadChannelSelect: document.querySelector("#unreadChannelSelect"),
  activeChannel: document.querySelector("#activeChannel"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  formatSelect: document.querySelector("#formatSelect"),
  zipOutput: document.querySelector("#zipOutput"),
  downloadMedia: document.querySelector("#downloadMedia"),
  maxMediaSize: document.querySelector("#maxMediaSize"),
  imagesOnly: document.querySelector("#imagesOnly"),
  statusText: document.querySelector("#statusText"),
  progressPercent: document.querySelector("#progressPercent"),
  progressFill: document.querySelector("#progressFill"),
  messageCount: document.querySelector("#messageCount"),
  mediaCount: document.querySelector("#mediaCount"),
  delayStatus: document.querySelector("#delayStatus"),
  startExport: document.querySelector("#startExport"),
  pauseExport: document.querySelector("#pauseExport"),
  cancelExport: document.querySelector("#cancelExport")
};

document.addEventListener("DOMContentLoaded", init);
els.refreshContext.addEventListener("click", hydrateContext);
els.startExport.addEventListener("click", startExport);
els.pauseExport.addEventListener("click", togglePause);
els.cancelExport.addEventListener("click", cancelExport);
els.tabs.forEach((tab) => tab.addEventListener("click", () => switchMode(tab.dataset.tab)));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "EXCORD_PROGRESS") {
    renderProgress(message.payload);
  }
});

async function init() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  els.startDate.value = toDateInput(weekAgo);
  els.endDate.value = toDateInput(today);
  await hydrateContext();
  const job = await chrome.runtime.sendMessage({ type: "EXCORD_GET_JOB" }).catch(() => null);
  if (job?.running) {
    state.running = true;
    state.paused = Boolean(job.paused);
    setRunning(true);
    renderProgress(job.progress);
  }
}

async function hydrateContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;

  if (!tab?.url?.startsWith("https://discord.com/")) {
    els.connectionStatus.textContent = "Open https://discord.com/app in this tab.";
    els.serverSelect.innerHTML = '<option value="">Discord tab not detected</option>';
    els.activeChannel.value = "Discord tab not detected";
    return;
  }

  els.connectionStatus.textContent = "Connected to Discord Web.";
  const context = await chrome.tabs.sendMessage(tab.id, { type: "EXCORD_GET_CONTEXT" }).catch(async () => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, { type: "EXCORD_GET_CONTEXT" });
  });

  const servers = context?.servers ?? [];
  els.serverSelect.innerHTML = servers.length
    ? servers
        .map((server) => {
          const label = server.active ? `${server.name} (current)` : server.name;
          return `<option value="${escapeAttr(server.id)}">${escapeHtml(label)}</option>`;
        })
        .join("")
    : '<option value="">No visible servers detected</option>';

  if (context?.activeServerId) {
    els.serverSelect.value = context.activeServerId;
  }
  els.activeChannel.value = context?.activeChannel?.name || "No active channel detected";
}

function switchMode(mode) {
  state.mode = mode;
  els.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === mode));
  els.panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === mode));
}

async function startExport() {
  if (!state.tabId) {
    await hydrateContext();
  }

  const payload = {
    tabId: state.tabId,
    mode: state.mode,
    serverId: els.serverSelect.value,
    unreadScope: els.unreadChannelSelect.value,
    startDate: els.startDate.value,
    endDate: els.endDate.value,
    format: els.formatSelect.value,
    zipOutput: els.zipOutput.checked,
    downloadMedia: els.downloadMedia.checked,
    maxMediaBytes: Number(els.maxMediaSize.value),
    imagesOnly: els.imagesOnly.checked
  };

  setRunning(true);
  renderProgress({ stage: "Starting export", percent: 2, messages: 0, media: 0, delayMs: 0 });
  const response = await chrome.runtime.sendMessage({ type: "EXCORD_START_EXPORT", payload }).catch((error) => ({
    ok: false,
    error: error.message
  }));

  if (!response?.ok) {
    setRunning(false);
    renderProgress({ stage: response?.error || "Unable to start export", percent: 0, messages: 0, media: 0, delayMs: 0 });
  }
}

async function togglePause() {
  state.paused = !state.paused;
  els.pauseExport.textContent = state.paused ? "Resume" : "Pause";
  await chrome.runtime.sendMessage({ type: state.paused ? "EXCORD_PAUSE_EXPORT" : "EXCORD_RESUME_EXPORT" });
}

async function cancelExport() {
  await chrome.runtime.sendMessage({ type: "EXCORD_CANCEL_EXPORT" });
  setRunning(false);
  renderProgress({ stage: "Cancelled", percent: 0, messages: 0, media: 0, delayMs: 0 });
}

function setRunning(isRunning) {
  state.running = isRunning;
  els.startExport.disabled = isRunning;
  els.pauseExport.disabled = !isRunning;
  els.cancelExport.disabled = !isRunning;
  els.pauseExport.textContent = "Pause";
  state.paused = false;
}

function renderProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
  els.statusText.textContent = progress.stage ?? "Idle";
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
  els.messageCount.textContent = String(progress.messages ?? 0);
  els.mediaCount.textContent = String(progress.media ?? 0);
  els.delayStatus.textContent = progress.delayMs ? `${Math.ceil(progress.delayMs / 1000)}s` : "0s";

  if (percent >= 100 || progress.done) {
    setRunning(false);
  }
}

function toDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
