(() => {
  if (window.__EXCORD_CONTENT_LOADED__) return;
  window.__EXCORD_CONTENT_LOADED__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let cancelled = false;
  let paused = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXCORD_GET_CONTEXT") {
      sendResponse(getDiscordContext());
      return false;
    }

    if (message?.type === "EXCORD_EXTRACT") {
      cancelled = false;
      paused = false;
      runExtraction(message.payload).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }

    if (message?.type === "EXCORD_CONTENT_PAUSE") {
      paused = true;
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "EXCORD_CONTENT_RESUME") {
      paused = false;
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "EXCORD_CONTENT_CANCEL") {
      cancelled = true;
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function runExtraction(options) {
    if (options.mode === "unread") {
      return extractUnreadServer(options);
    }
    return extractActiveRange(options);
  }

  function getDiscordContext() {
    const servers = collectServers();
    const channels = collectVisibleChannels();
    const path = new URL(location.href).pathname.split("/").filter(Boolean);
    const activeServerId = path[1] && path[1] !== "@me" ? path[1] : "";
    const activeChannelId = path[2] || "";
    const activeChannel = channels.find((channel) => channel.id === activeChannelId) || {
      id: activeChannelId,
      name: detectActiveChatName(),
      type: activeServerId ? "channel" : "dm"
    };

    return { servers, channels, activeServerId, activeChannel };
  }

  async function extractUnreadServer(options) {
    const context = getDiscordContext();
    const targetServer = context.servers.find((server) => server.id === options.serverId) || context.servers[0];
    if (!targetServer) throw new Error("No visible Discord server was detected.");

    await clickAndWait(targetServer.elementSelector);
    await waitForStableChatList();
    const channels = collectVisibleChannels().filter((channel) => {
      if (options.unreadScope === "visible") return channel.href;
      return channel.unread || channel.mentions > 0;
    });

    const grouped = {};
    const allMessages = [];
    for (let index = 0; index < channels.length; index += 1) {
      await waitWhilePaused();
      if (cancelled) break;
      const channel = channels[index];
      progress(`Opening ${channel.name}`, Math.round((index / Math.max(1, channels.length)) * 45), allMessages.length, 0, jitter(index));
      await clickAndWait(channel.elementSelector);
      await waitForStableChatList();
      await scrollToUnreadMarker();
      const messages = await collectMessagesFromViewport({ unreadOnly: true });
      grouped[channel.name] = {
        channel,
        exportedAt: new Date().toISOString(),
        messages
      };
      allMessages.push(...messages.map((message) => ({ ...message, channelName: channel.name, channelId: channel.id })));
      await sleep(jitter(index));
    }

    return {
      ok: true,
      exportKind: "server-unread",
      server: sanitizeTarget(targetServer),
      activeChat: getDiscordContext().activeChannel,
      grouped,
      messages: dedupeMessages(allMessages)
    };
  }

  async function extractActiveRange(options) {
    const start = startOfDay(options.startDate);
    const end = endOfDay(options.endDate);
    if (!start || !end || start > end) throw new Error("Choose a valid start and end date.");

    const context = getDiscordContext();
    const messages = new Map();
    const scroller = findMessageScroller();
    let oldestSeen = null;
    let unchangedPasses = 0;

    for (let pass = 0; pass < 240; pass += 1) {
      await waitWhilePaused();
      if (cancelled) break;
      const visible = parseVisibleMessages();
      let added = 0;
      for (const message of visible) {
        const time = Date.parse(message.timestamp || "");
        if (!Number.isFinite(time)) continue;
        oldestSeen = oldestSeen === null ? time : Math.min(oldestSeen, time);
        if (time >= start.getTime() && time <= end.getTime() && !messages.has(message.id)) {
          messages.set(message.id, { ...message, channelName: context.activeChannel.name, channelId: context.activeChannel.id });
          added += 1;
        }
      }

      progress("Scanning message history", Math.min(80, 10 + pass), messages.size, 0, jitter(pass));
      if (oldestSeen !== null && oldestSeen < start.getTime()) break;
      if (!scrollOlder(scroller)) break;
      unchangedPasses = added === 0 ? unchangedPasses + 1 : 0;
      if (unchangedPasses > 24 && visible.length === 0) break;
      await sleep(jitter(pass));
    }

    return {
      ok: true,
      exportKind: "channel-date-range",
      server: context.servers.find((server) => server.id === context.activeServerId) || null,
      activeChat: context.activeChannel,
      range: { startDate: options.startDate, endDate: options.endDate },
      grouped: {
        [context.activeChannel.name]: {
          channel: context.activeChannel,
          messages: [...messages.values()].sort(compareMessages)
        }
      },
      messages: [...messages.values()].sort(compareMessages)
    };
  }

  async function collectMessagesFromViewport({ unreadOnly }) {
    const scroller = findMessageScroller();
    const messages = new Map();
    let reachedBottom = false;
    let passes = 0;

    while (!reachedBottom && passes < 80) {
      await waitWhilePaused();
      if (cancelled) break;
      for (const message of parseVisibleMessages()) {
        if (!unreadOnly || message.isAfterUnreadMarker) messages.set(message.id, message);
      }
      reachedBottom = scrollNewer(scroller);
      passes += 1;
      await sleep(jitter(passes));
    }
    return [...messages.values()].sort(compareMessages);
  }

  function parseVisibleMessages() {
    const nodes = document.querySelectorAll('[id^="chat-messages-"], [data-list-item-id^="chat-messages___chat-messages-"]');
    return [...nodes].map(parseMessageNode).filter(Boolean);
  }

  function parseMessageNode(node) {
    const id = node.id || node.getAttribute("data-list-item-id") || stableHash(node.textContent || "");
    const authorNode = pick(node, ['[class*="username"]', '[data-slate-node="element"] strong', 'h3 span']);
    const timeNode = pick(node, ["time[datetime]", "time"]);
    const contentNode = pick(node, ['[id^="message-content-"]', '[class*="messageContent"]']);
    const avatar = pick(node, ['img[class*="avatar"]', 'img[alt*="avatar"]']);
    const attachmentNodes = [...node.querySelectorAll('a[href], img[src], video source[src], audio source[src]')];
    const attachments = attachmentNodes
      .map((item) => attachmentFromNode(item))
      .filter((attachment, index, list) => attachment.url && list.findIndex((other) => other.url === attachment.url) === index);
    const reactions = [...node.querySelectorAll('[aria-label*="reaction" i], [class*="reaction"]')]
      .map((reaction) => reaction.getAttribute("aria-label") || reaction.textContent?.trim())
      .filter(Boolean);

    const timestamp = timeNode?.getAttribute("datetime") || inferTimestampFromSnowflake(id);
    const text = normalizeText(contentNode?.innerText || node.querySelector('[class*="markup"]')?.innerText || "");
    if (!text && attachments.length === 0 && !timestamp) return null;

    return {
      id,
      author: normalizeText(authorNode?.textContent || "Unknown"),
      authorId: extractAuthorId(node),
      avatarUrl: avatar?.src || "",
      timestamp,
      text,
      attachments,
      embeds: collectEmbeds(node),
      reactions,
      isSystem: Boolean(node.querySelector('[class*="systemMessage"]')),
      isAfterUnreadMarker: isAfterUnreadMarker(node),
      permalink: location.href
    };
  }

  function collectServers() {
    return [...document.querySelectorAll('nav a[href^="/channels/"], [data-list-item-id^="guildsnav___"] a[href^="/channels/"]')]
      .map((anchor, index) => {
        const match = anchor.getAttribute("href")?.match(/\/channels\/([^/]+)/);
        if (!match || match[1] === "@me") return null;
        return {
          id: match[1],
          name: readableLabel(anchor) || `Server ${index + 1}`,
          href: anchor.href,
          elementSelector: selectorFor(anchor),
          unread: hasUnread(anchor),
          mentions: mentionCount(anchor)
        };
      })
      .filter(Boolean)
      .filter((server, index, list) => list.findIndex((item) => item.id === server.id) === index);
  }

  function collectVisibleChannels() {
    return [...document.querySelectorAll('a[href^="/channels/"]')]
      .map((anchor, index) => {
        const match = anchor.getAttribute("href")?.match(/\/channels\/([^/]+)\/([^/]+)/);
        if (!match) return null;
        return {
          id: match[2],
          serverId: match[1],
          name: readableLabel(anchor) || anchor.textContent?.trim() || `Channel ${index + 1}`,
          href: anchor.href,
          type: match[1] === "@me" ? "dm" : "channel",
          elementSelector: selectorFor(anchor),
          unread: hasUnread(anchor),
          mentions: mentionCount(anchor)
        };
      })
      .filter(Boolean)
      .filter((channel, index, list) => list.findIndex((item) => item.id === channel.id) === index);
  }

  function findMessageScroller() {
    const list = document.querySelector('[data-list-id="chat-messages"], ol[data-list-id="chat-messages"]');
    return list?.closest('[class*="scroller"]') || list?.parentElement || document.scrollingElement;
  }

  async function scrollToUnreadMarker() {
    const marker = [...document.querySelectorAll('[class*="unread"], [id*="unread"], div')]
      .find((node) => /new messages|unread/i.test(node.textContent || ""));
    if (marker) marker.scrollIntoView({ block: "center" });
    await sleep(600);
  }

  function scrollOlder(scroller) {
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(650, scroller.clientHeight * 0.85));
    return before !== scroller.scrollTop;
  }

  function scrollNewer(scroller) {
    if (!scroller) return true;
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(700, scroller.clientHeight));
    return before === scroller.scrollTop || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  }

  async function clickAndWait(selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error("A Discord navigation target disappeared before it could be opened.");
    node.click();
    await sleep(1200);
  }

  async function waitForStableChatList() {
    for (let index = 0; index < 20; index += 1) {
      if (findMessageScroller() && document.querySelector('[id^="chat-messages-"], [data-list-id="chat-messages"]')) return;
      await sleep(250);
    }
  }

  async function waitWhilePaused() {
    while (paused && !cancelled) await sleep(250);
  }

  function progress(stage, percent, messages, media, delayMs) {
    chrome.runtime.sendMessage({ type: "EXCORD_CONTENT_PROGRESS", payload: { stage, percent, messages, media, delayMs } }).catch(() => {});
  }

  function attachmentFromNode(node) {
    const url = node.href || node.src || "";
    return {
      url,
      filename: decodeURIComponent(url.split("/").pop()?.split("?")[0] || "attachment"),
      contentType: inferContentType(url),
      kind: inferKind(url),
      alt: node.alt || node.textContent?.trim() || ""
    };
  }

  function collectEmbeds(node) {
    return [...node.querySelectorAll('article, [class*="embed"] a[href]')]
      .map((embed) => ({ text: normalizeText(embed.textContent || ""), url: embed.href || "" }))
      .filter((embed) => embed.text || embed.url);
  }

  function isAfterUnreadMarker(node) {
    let current = node;
    while (current?.previousElementSibling) {
      current = current.previousElementSibling;
      if (/new messages|unread/i.test(current.textContent || "")) return true;
    }
    return !document.body.textContent?.match(/new messages|unread/i);
  }

  function extractAuthorId(node) {
    const id = node.querySelector('[id^="message-username-"]')?.id || "";
    return id.match(/(\d{12,})/)?.[1] || "";
  }

  function inferTimestampFromSnowflake(id) {
    const match = String(id).match(/(\d{15,})/);
    if (!match) return "";
    const snowflake = BigInt(match[1]);
    const discordEpoch = 1420070400000n;
    return new Date(Number((snowflake >> 22n) + discordEpoch)).toISOString();
  }

  function startOfDay(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function endOfDay(value) {
    if (!value) return null;
    const date = new Date(`${value}T23:59:59.999`);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function detectActiveChatName() {
    return normalizeText(
      document.querySelector('[class*="title"] h1, [data-text-variant="heading-lg/semibold"], h1')?.textContent ||
        document.title.replace(/\s*\|\s*Discord.*$/, "") ||
        "Active chat"
    );
  }

  function pick(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function readableLabel(node) {
    return normalizeText(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "");
  }

  function hasUnread(node) {
    return Boolean(node.closest('[class*="unread"]') || node.querySelector('[class*="unread"], [class*="pill"]'));
  }

  function mentionCount(node) {
    const text = node.textContent || "";
    const match = text.match(/\b(\d{1,4})\b/);
    return match ? Number(match[1]) : 0;
  }

  function selectorFor(node) {
    if (!node.dataset.excordId) node.dataset.excordId = `x${crypto.randomUUID()}`;
    return `[data-excord-id="${CSS.escape(node.dataset.excordId)}"]`;
  }

  function inferKind(url) {
    if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url)) return "image";
    if (/\.(mp4|mov|webm|mkv)(\?|$)/i.test(url)) return "video";
    if (/\.(mp3|wav|ogg|flac|m4a)(\?|$)/i.test(url)) return "audio";
    if (/\.pdf(\?|$)/i.test(url)) return "document";
    return "link";
  }

  function inferContentType(url) {
    const kind = inferKind(url);
    if (kind === "image") return `image/${url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.replace("jpg", "jpeg") || "jpeg"}`;
    if (kind === "video") return "video/mp4";
    if (kind === "audio") return "audio/mpeg";
    if (kind === "document") return "application/pdf";
    return "";
  }

  function sanitizeTarget(target) {
    if (!target) return null;
    const { elementSelector, ...rest } = target;
    return rest;
  }

  function dedupeMessages(messages) {
    return [...new Map(messages.map((message) => [message.id, message])).values()].sort(compareMessages);
  }

  function compareMessages(a, b) {
    return String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function stableHash(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(31, hash) + text.charCodeAt(index);
    return `message-${Math.abs(hash)}`;
  }

  function jitter(seed) {
    return 500 + ((seed * 197) % 1000);
  }
})();
