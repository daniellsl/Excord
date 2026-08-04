importScripts("vendor/jszip-lite.js");

const job = {
  running: false,
  paused: false,
  cancelled: false,
  tabId: null,
  progress: { stage: "Idle", percent: 0, messages: 0, media: 0, delayMs: 0 }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXCORD_GET_JOB") {
    sendResponse({ running: job.running, paused: job.paused, progress: job.progress });
    return false;
  }

  if (message?.type === "EXCORD_START_EXPORT") {
    startExport(message.payload).then(sendResponse).catch((error) => {
      updateProgress({ stage: error.message, percent: 0 });
      finishJob();
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "EXCORD_PAUSE_EXPORT") {
    job.paused = true;
    if (job.tabId) chrome.tabs.sendMessage(job.tabId, { type: "EXCORD_CONTENT_PAUSE" }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "EXCORD_RESUME_EXPORT") {
    job.paused = false;
    if (job.tabId) chrome.tabs.sendMessage(job.tabId, { type: "EXCORD_CONTENT_RESUME" }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "EXCORD_CANCEL_EXPORT") {
    job.cancelled = true;
    job.paused = false;
    if (job.tabId) chrome.tabs.sendMessage(job.tabId, { type: "EXCORD_CONTENT_CANCEL" }).catch(() => {});
    finishJob();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "EXCORD_CONTENT_PROGRESS") {
    updateProgress(message.payload);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startExport(options) {
  if (job.running) return { ok: false, error: "An export is already running." };
  if (!options?.tabId) return { ok: false, error: "No Discord tab is active." };

  Object.assign(job, {
    running: true,
    paused: false,
    cancelled: false,
    tabId: options.tabId,
    progress: { stage: "Starting export", percent: 2, messages: 0, media: 0, delayMs: 0 }
  });
  broadcast();

  try {
    const extraction = await chrome.tabs.sendMessage(options.tabId, { type: "EXCORD_EXTRACT", payload: options });
    if (!extraction?.ok) throw new Error(extraction?.error || "Discord extraction failed.");
    if (job.cancelled) return { ok: false, error: "Export cancelled." };

    updateProgress({ stage: "Formatting chat log", percent: 84, messages: extraction.messages.length });
    const prepared = prepareExport(extraction, options);
    const mediaResult = await maybeDownloadMedia(prepared.messages, options);
    prepared.mediaFiles = mediaResult.files;
    prepared.mediaMap = mediaResult.map;
    rewriteLocalMedia(prepared.messages, mediaResult.map);
    rewriteGroupedMedia(prepared.grouped, mediaResult.map);

    updateProgress({ stage: options.zipOutput ? "Building ZIP archive" : "Preparing download", percent: 96 });
    await savePreparedExport(prepared, options);
    updateProgress({
      stage: "Export complete",
      percent: 100,
      messages: prepared.messages.length,
      media: mediaResult.files.length,
      delayMs: 0,
      done: true
    });
    finishJob();
    return { ok: true };
  } catch (error) {
    finishJob();
    throw error;
  }
}

function prepareExport(extraction, options) {
  const exportedAt = new Date().toISOString();
  const baseName = safeFileName(
    [
      "discord",
      extraction.server?.name || extraction.activeChat?.name || "export",
      extraction.exportKind,
      exportedAt.slice(0, 19).replace(/[T:]/g, "-")
    ].join("-")
  );

  const messages = sortMessagesForExport(extraction.messages || []).map((message) => ({ ...message }));

  return {
    baseName,
    metadata: {
      exportedAt,
      exportKind: extraction.exportKind,
      server: extraction.server,
      activeChat: extraction.activeChat,
      range: extraction.range || null,
      messageCount: messages.length,
      format: options.format
    },
    grouped: sortGroupedForExport(extraction.grouped || {}),
    messages
  };
}

async function maybeDownloadMedia(messages, options) {
  const map = {};
  const files = [];
  if (!options.downloadMedia || !options.zipOutput) return { map, files };

  const attachments = collectDownloadableAttachments(messages, options);
  for (let index = 0; index < attachments.length; index += 1) {
    await waitWhilePaused();
    if (job.cancelled) break;
    const attachment = attachments[index];
    const delayMs = adaptiveDelay(index);
    updateProgress({
      stage: `Downloading media ${index + 1} of ${attachments.length}`,
      percent: 84 + Math.round((index / Math.max(1, attachments.length)) * 10),
      media: files.length,
      delayMs
    });
    await sleep(delayMs);

    const downloaded = await downloadAttachmentWithBackoff(attachment, options.maxMediaBytes).catch((error) => ({
      error: error.message
    }));
    if (downloaded?.blob) {
      const mediaPath = `media/${downloaded.filename}`;
      map[attachment.url] = mediaPath;
      files.push({ path: mediaPath, blob: downloaded.blob, sourceUrl: attachment.url });
    }
  }
  return { map, files };
}

function collectDownloadableAttachments(messages, options) {
  const seen = new Set();
  const attachments = [];
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      if (!isDiscordMediaUrl(attachment.url) || seen.has(attachment.url)) continue;
      if (options.imagesOnly && attachment.kind !== "image") continue;
      seen.add(attachment.url);
      attachments.push(attachment);
    }
  }
  return attachments;
}

async function downloadAttachmentWithBackoff(attachment, maxBytes, attempt = 0) {
  try {
    return await downloadAttachment(attachment, maxBytes);
  } catch (error) {
    if (attempt >= 4 || job.cancelled) throw error;
    const delayMs = Math.min(10000, 750 * 2 ** attempt);
    updateProgress({ stage: `Network retry for ${attachment.filename}`, delayMs });
    await sleep(delayMs);
    return downloadAttachmentWithBackoff(attachment, maxBytes, attempt + 1);
  }
}

async function downloadAttachment(attachment, maxBytes) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  try {
    const head = await fetch(attachment.url, { method: "HEAD", credentials: "include", signal: controller.signal }).catch(() => null);
    const size = Number(head?.headers?.get("content-length") || 0);
    if (size && size > maxBytes) throw new Error(`Skipped ${attachment.filename}: file is larger than the configured limit.`);

    const response = await fetch(attachment.url, { credentials: "include", signal: controller.signal });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") || 2) * 1000;
      updateProgress({ stage: "Discord rate limit; backing off", delayMs: retryAfter });
      await sleep(retryAfter);
      return downloadAttachment(attachment, maxBytes);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await responseToLimitedBlob(response, maxBytes, attachment.filename);
    return { blob, filename: uniqueMediaName(attachment.filename, attachment.url, blob.type) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function responseToLimitedBlob(response, maxBytes, filename) {
  if (!response.body?.getReader) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new Error(`Skipped ${filename}: file is larger than the configured limit.`);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Skipped ${filename}: file is larger than the configured limit.`);
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
}

async function savePreparedExport(prepared, options) {
  const exportText = renderFormat(prepared, options.format);
  const extension = options.format === "html" ? "html" : options.format;
  const logPath = `logs/${prepared.baseName}.${extension}`;
  const manifestText = JSON.stringify(
    {
      ...prepared.metadata,
      mediaFiles: prepared.mediaFiles.map((file) => ({ path: file.path, sourceUrl: file.sourceUrl }))
    },
    null,
    2
  );

  if (options.zipOutput) {
    const zip = new JSZip();
    zip.file("manifest.json", manifestText);
    zip.file(logPath, exportText);
    if (options.format !== "json") {
      zip.file(`logs/${prepared.baseName}.json`, JSON.stringify({ metadata: prepared.metadata, messages: prepared.messages }, null, 2));
    }
    for (const file of prepared.mediaFiles) {
      zip.file(file.path, file.blob);
    }
    const blob = await zip.generateAsync({ type: "blob" }, (meta) => {
      updateProgress({ stage: meta.currentFile ? `Packing ${meta.currentFile}` : "Building ZIP archive", percent: 96 + Math.round(meta.percent / 25) });
    });
    await downloadBlob(blob, `${prepared.baseName}.zip`);
    return;
  }

  await downloadBlob(new Blob([exportText], { type: mimeFor(options.format) }), `${prepared.baseName}.${extension}`);
}

function renderFormat(prepared, format) {
  if (format === "csv") return renderCsv(prepared.messages);
  if (format === "html") return renderHtml(prepared);
  return JSON.stringify({ metadata: prepared.metadata, grouped: prepared.grouped, messages: prepared.messages }, null, 2);
}

function sortGroupedForExport(grouped) {
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .reduce((ordered, [name, group]) => {
      ordered[name] = {
        ...group,
        messages: sortMessagesForExport(group.messages || [])
      };
      return ordered;
    }, {});
}

function sortMessagesForExport(messages) {
  return [...messages].sort(compareExportMessages);
}

function compareExportMessages(a, b) {
  const channelCompare = String(a.channelName || "").localeCompare(String(b.channelName || ""), undefined, { sensitivity: "base" });
  if (channelCompare) return channelCompare;
  const timestampCompare = String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  return timestampCompare || compareMessageIds(a.id, b.id);
}

function compareMessageIds(a, b) {
  const aText = String(a || "");
  const bText = String(b || "");
  const aBig = /^\d+$/.test(aText) ? BigInt(aText) : null;
  const bBig = /^\d+$/.test(bText) ? BigInt(bText) : null;
  if (aBig !== null && bBig !== null) return aBig > bBig ? 1 : aBig < bBig ? -1 : 0;
  return aText.localeCompare(bText);
}

function renderCsv(messages) {
  const headers = ["channelName", "id", "author", "authorId", "timestamp", "text", "attachments", "reactions", "permalink"];
  const rows = messages.map((message) =>
    headers.map((key) => csvCell(Array.isArray(message[key]) ? JSON.stringify(message[key]) : message[key] ?? "")).join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

function renderHtml(prepared) {
  const groups = groupBy(prepared.messages, (message) => message.channelName || "Messages");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(prepared.metadata.server?.name || prepared.metadata.activeChat?.name || "Discord Export")}</title>
<style>
body{margin:0;background:#313338;color:#dbdee1;font:15px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;background:#1e1f22;border-bottom:1px solid #3f4147;padding:18px 24px;z-index:2}
h1{font-size:22px;margin:0 0 4px}p{margin:0;color:#b5bac1}.channel{padding:20px 24px;border-bottom:1px solid #3f4147}
h2{font-size:18px;margin:0 0 16px;color:#fff}.message{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:8px 0}
.avatar{width:40px;height:40px;border-radius:50%;background:#232428}.meta{display:flex;gap:8px;align-items:baseline}.author{font-weight:700;color:#f2f3f5}.time{font-size:12px;color:#949ba4}
.text{white-space:pre-wrap;margin-top:2px}.attachments{display:grid;gap:8px;margin-top:8px}.attachments img,.attachments video{max-width:min(520px,100%);border-radius:6px}
a{color:#00a8fc}.reactions{margin-top:6px;color:#b5bac1;font-size:12px}
</style>
</head>
<body>
<header><h1>${escapeHtml(prepared.metadata.server?.name || prepared.metadata.activeChat?.name || "Discord Export")}</h1><p>${escapeHtml(prepared.metadata.exportKind)} · ${prepared.metadata.messageCount} messages · exported ${escapeHtml(prepared.metadata.exportedAt)}</p></header>
${Object.entries(groups).map(([channel, messages]) => `<section class="channel"><h2># ${escapeHtml(channel)}</h2>${messages.map(renderHtmlMessage).join("")}</section>`).join("")}
</body>
</html>`;
}

function renderHtmlMessage(message) {
  const avatar = message.avatarUrl ? `<img class="avatar" src="${escapeAttr(message.avatarUrl)}" alt="">` : `<div class="avatar"></div>`;
  return `<article class="message">
${avatar}
<div>
<div class="meta"><span class="author">${escapeHtml(message.author)}</span><time class="time">${escapeHtml(message.timestamp || "")}</time></div>
<div class="text">${linkify(escapeHtml(message.text || ""))}</div>
${renderAttachments(message.attachments || [])}
${message.reactions?.length ? `<div class="reactions">${escapeHtml(message.reactions.join(" · "))}</div>` : ""}
</div>
</article>`;
}

function renderAttachments(attachments) {
  if (!attachments.length) return "";
  return `<div class="attachments">${attachments.map((attachment) => {
    const href = escapeAttr(attachment.localPath || attachment.url);
    const label = escapeHtml(attachment.filename || attachment.url);
    if (attachment.kind === "image") return `<a href="${href}"><img src="${href}" alt="${label}"></a>`;
    if (attachment.kind === "video") return `<video controls src="${href}"></video>`;
    if (attachment.kind === "audio") return `<audio controls src="${href}"></audio>`;
    return `<a href="${href}">${label}</a>`;
  }).join("")}</div>`;
}

function rewriteLocalMedia(messages, mediaMap) {
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      if (mediaMap[attachment.url]) attachment.localPath = `../${mediaMap[attachment.url]}`;
    }
  }
}

function rewriteGroupedMedia(grouped, mediaMap) {
  for (const group of Object.values(grouped || {})) {
    rewriteLocalMedia(group.messages || [], mediaMap);
  }
}

async function waitWhilePaused() {
  while (job.paused && !job.cancelled) {
    updateProgress({ stage: "Paused" });
    await sleep(250);
  }
}

function updateProgress(patch) {
  job.progress = { ...job.progress, ...patch };
  broadcast();
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "EXCORD_PROGRESS", payload: job.progress }).catch(() => {});
}

function finishJob() {
  job.running = false;
  job.paused = false;
  job.cancelled = false;
}

async function downloadBlob(blob, filename) {
  const url = await blobToDataUrl(blob);
  await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function adaptiveDelay(index) {
  return 500 + Math.min(1000, (index % 8) * 125);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDiscordMediaUrl(url) {
  return /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(url || "");
}

function uniqueMediaName(filename, url, contentType) {
  const clean = safeFileName(filename || "attachment");
  const ext = clean.includes(".") ? "" : extensionFor(contentType, url);
  return `${hashUrl(url)}-${clean}${ext}`;
}

function extensionFor(contentType, url) {
  const fromUrl = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1];
  if (fromUrl) return `.${fromUrl}`;
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("video")) return ".mp4";
  if (contentType?.includes("audio")) return ".mp3";
  if (contentType?.includes("pdf")) return ".pdf";
  return ".bin";
}

function safeFileName(name) {
  return String(name || "discord-export").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || "discord-export";
}

function hashUrl(url) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function mimeFor(format) {
  if (format === "html") return "text/html;charset=utf-8";
  if (format === "csv") return "text/csv;charset=utf-8";
  return "application/json;charset=utf-8";
}

function linkify(html) {
  return html.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${escapeAttr(url)}">${url}</a>`);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
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
