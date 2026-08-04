const state = {
  tabId: null,
  mode: "unread",
  running: false,
  paused: false,
  context: null,
  skipChannelIds: new Set(),
  skipChannelQuery: ""
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  refreshContext: document.querySelector("#refreshContext"),
  tabs: [...document.querySelectorAll(".tab")],
  panels: [...document.querySelectorAll(".panel")],
  serverSelect: document.querySelector("#serverSelect"),
  unreadChannelSelect: document.querySelector("#unreadChannelSelect"),
  skipChannelDropdown: document.querySelector("#skipChannelDropdown"),
  skipChannelValues: document.querySelector("#skipChannelValues"),
  skipChannelSearch: document.querySelector("#skipChannelSearch"),
  skipChannelMenu: document.querySelector("#skipChannelMenu"),
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
els.serverSelect.addEventListener("change", async () => {
  state.skipChannelQuery = "";
  els.skipChannelSearch.value = "";
  await restoreSkipChannelSelection();
  renderSkipChannelPicker();
});
els.skipChannelDropdown.addEventListener("click", () => focusSkipChannelSearch());
els.skipChannelSearch.addEventListener("focus", () => setSkipMenuOpen(true));
els.skipChannelSearch.addEventListener("input", () => {
  state.skipChannelQuery = els.skipChannelSearch.value;
  renderSkipChannelPicker();
  setSkipMenuOpen(true);
});
els.skipChannelSearch.addEventListener("keydown", handleSkipChannelKeydown);
document.addEventListener("click", (event) => {
  if (!els.skipChannelDropdown.contains(event.target)) setSkipMenuOpen(false);
});
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
  els.startDate.value = toDateTimeInput(weekAgo);
  els.endDate.value = toDateTimeInput(today);
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

  state.context = context || null;
  const servers = context?.servers ?? [];
  els.serverSelect.innerHTML = servers.length
    ? servers
        .map((server) => {
          const label = server.active ? `${server.name} (current)` : server.name;
          return `<option value="${escapeAttr(server.id)}">${escapeHtml(label)}</option>`;
        })
        .join("")
    : '<option value="">No visible servers detected</option>';

  const activeServerIndex = servers.findIndex((server) => server.id === context?.activeServerId || server.active);
  if (activeServerIndex >= 0) {
    els.serverSelect.selectedIndex = activeServerIndex;
  } else if (context?.activeServerId) {
    els.serverSelect.value = context.activeServerId;
  }
  els.activeChannel.value = context?.activeChannel?.name || "No active channel detected";
  state.skipChannelQuery = "";
  els.skipChannelSearch.value = "";
  await restoreSkipChannelSelection();
  renderSkipChannelPicker();
}

function renderSkipChannelPicker() {
  const channels = currentServerChannels();
  const selected = channels.filter((channel) => state.skipChannelIds.has(channel.id));
  const query = normalizeSearch(state.skipChannelQuery);
  const matches = channels
    .filter((channel) => !state.skipChannelIds.has(channel.id))
    .filter((channel) => !query || normalizeSearch(channel.name).includes(query))
    .slice(0, 24);

  els.skipChannelValues.innerHTML = selected
    .map(
      (channel) => `<button class="multi-search-chip" type="button" data-remove-channel-id="${escapeAttr(channel.id)}">${escapeHtml(channel.name)}<span aria-hidden="true">×</span></button>`
    )
    .join("");
  els.skipChannelValues.querySelectorAll("[data-remove-channel-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.skipChannelIds.delete(button.dataset.removeChannelId);
      persistSkipChannelSelection();
      renderSkipChannelPicker();
      focusSkipChannelSearch();
    });
  });

  els.skipChannelMenu.innerHTML = matches.length
    ? matches
        .map((channel) => {
          const meta = channel.muted ? '<span class="multi-search-meta">Muted</span>' : "";
          return `<button class="multi-search-item" type="button" role="option" data-channel-id="${escapeAttr(channel.id)}"><span># ${escapeHtml(channel.name)}</span>${meta}</button>`;
        })
        .join("")
    : `<div class="multi-search-empty">${channels.length ? "No matching channels" : "No loaded channels for this server"}</div>`;
  els.skipChannelMenu.querySelectorAll("[data-channel-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.skipChannelIds.add(button.dataset.channelId);
      persistSkipChannelSelection();
      state.skipChannelQuery = "";
      els.skipChannelSearch.value = "";
      renderSkipChannelPicker();
      focusSkipChannelSearch();
    });
  });
}


async function restoreSkipChannelSelection() {
  const serverId = els.serverSelect.value;
  if (!serverId) {
    state.skipChannelIds.clear();
    return;
  }
  const key = skipChannelStorageKey(serverId);
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  state.skipChannelIds = new Set(Array.isArray(stored[key]) ? stored[key] : []);
}

async function persistSkipChannelSelection() {
  const serverId = els.serverSelect.value;
  if (!serverId) return;
  await chrome.storage.local.set({ [skipChannelStorageKey(serverId)]: [...state.skipChannelIds] }).catch(() => {});
}

function skipChannelStorageKey(serverId) {
  return `skipChannels:${serverId}`;
}

function currentServerChannels() {
  return (state.context?.channels ?? [])
    .filter((channel) => channel.serverId === els.serverSelect.value)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectedSkipChannelIds() {
  return [...state.skipChannelIds];
}

function setSkipMenuOpen(isOpen) {
  els.skipChannelDropdown.classList.toggle("is-open", isOpen);
  els.skipChannelDropdown.setAttribute("aria-expanded", String(isOpen));
}

function focusSkipChannelSearch() {
  els.skipChannelSearch.focus();
  setSkipMenuOpen(true);
}

function handleSkipChannelKeydown(event) {
  if (event.key === "Escape") {
    setSkipMenuOpen(false);
    els.skipChannelSearch.blur();
  }
  if (event.key === "Backspace" && !els.skipChannelSearch.value && state.skipChannelIds.size) {
    const last = [...state.skipChannelIds].at(-1);
    state.skipChannelIds.delete(last);
    persistSkipChannelSelection();
    renderSkipChannelPicker();
  }
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
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
    skipChannelIds: selectedSkipChannelIds(),
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

function toDateTimeInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
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
