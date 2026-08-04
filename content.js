(() => {
  if (window.__EXCORD_CONTENT_LOADED__) return;
  window.__EXCORD_CONTENT_LOADED__ = true;

  const MSG = {
    GET_CONTEXT: "EXCORD_GET_CONTEXT",
    EXTRACT: "EXCORD_EXTRACT",
    CONTENT_PAUSE: "EXCORD_CONTENT_PAUSE",
    CONTENT_RESUME: "EXCORD_CONTENT_RESUME",
    CONTENT_CANCEL: "EXCORD_CONTENT_CANCEL",
    CONTENT_PROGRESS: "EXCORD_CONTENT_PROGRESS"
  };

  const SELECTORS = {
    channelLinks: 'a[href^="/channels/"]',
    guildLinks: 'a[href^="/channels/"], a[href^="https://discord.com/channels/"]',
    messageList: '[data-list-id="chat-messages"], ol[data-list-id="chat-messages"]',
    messageNode: '[id^="chat-messages-"], [data-list-item-id^="chat-messages___chat-messages-"]',
    messageReady: '[id^="chat-messages-"], [data-list-id="chat-messages"]',
    messageContent: '[id^="message-content-"]',
    messageContentOrMarkup: '[id^="message-content-"], [class*="messageContent"]',
    messageUsername: '[id^="message-username-"]',
    unreadMarkerCandidate: '[class*="unread" i], [id*="unread" i], [class*="divider" i], [role="separator"], [aria-label*="new" i], div'
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let cancelled = false;
  let paused = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.GET_CONTEXT) {
      sendResponse(getDiscordContext());
      return false;
    }

    if (message?.type === MSG.EXTRACT) {
      cancelled = false;
      paused = false;
      runExtraction(message.payload).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }

    if (message?.type === MSG.CONTENT_PAUSE) {
      paused = true;
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === MSG.CONTENT_RESUME) {
      paused = false;
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === MSG.CONTENT_CANCEL) {
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
    const path = new URL(location.href).pathname.split("/").filter(Boolean);
    const activeServerId = detectActiveServerId();
    const servers = upsertActiveServer(collectServers(activeServerId), activeServerId);
    const channels = collectVisibleChannels();
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

    if (targetServer.elementSelector) {
      await clickAndWait(targetServer.elementSelector);
      await waitForStableChatList();
    }
    const visibleChannels = collectVisibleChannels();
    const skippedChannelIds = new Set(options.skipChannelIds || []);
    const excludedChannelNames = parseExcludedChannelNames(options.excludeChannels);
    const channels = visibleChannels.filter((channel) => {
      if (channel.muted || skippedChannelIds.has(channel.id) || excludedChannelNames.has(normalizeChannelName(channel.name))) return false;
      if (options.unreadScope === "visible") return channel.href;
      return channel.unread || channel.mentions > 0;
    });

    if (!channels.length && options.unreadScope !== "visible") {
      progress(`No unread channels detected among ${visibleChannels.length} visible channels`, 100, 0, 0, 0);
    }

    const grouped = {};
    const allMessages = [];
    for (let index = 0; index < channels.length; index += 1) {
      await waitWhilePaused();
      if (cancelled) break;
      const channel = channels[index];
      progress(`Opening ${channel.name}`, Math.round((index / Math.max(1, channels.length)) * 45), allMessages.length, 0, jitter(index));
      await clickAndWait(channel.elementSelector);
      await waitForStableChatList();
      const unreadMarker = await scrollToUnreadMarker();
      if (!unreadMarker) {
        progress(`Skipping ${channel.name}: unread marker was not visible`, Math.round((index / Math.max(1, channels.length)) * 45), allMessages.length, 0, 0);
        await sleep(jitter(index));
        continue;
      }
      const messages = await collectUnreadMessagesToLatest(unreadMarker);
      if (messages.length) {
        grouped[channel.name] = {
          channel,
          exportedAt: new Date().toISOString(),
          messages
        };
        allMessages.push(...messages.map((message) => ({ ...message, channelName: channel.name, channelId: channel.id })));
      }
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
    const start = parseDateTimeInput(options.startDate);
    const end = parseDateTimeInput(options.endDate);
    if (!start || !end || start > end) throw new Error("Choose a valid start and end date/time.");

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
      range: {
        startDateTime: options.startDate,
        endDateTime: options.endDate,
        startDate: options.startDate,
        endDate: options.endDate
      },
      grouped: {
        [context.activeChannel.name]: {
          channel: context.activeChannel,
          messages: [...messages.values()].sort(compareMessages)
        }
      },
      messages: [...messages.values()].sort(compareMessages)
    };
  }

  async function collectUnreadMessagesToLatest(marker) {
    const boundary = findOldestUnreadBoundary(marker);
    if (!boundary) return [];

    const scroller = findMessageScroller();
    const messages = new Map();
    let reachedBottom = false;
    let passes = 0;

    while (!reachedBottom && passes < 120) {
      await waitWhilePaused();
      if (cancelled) break;
      for (const message of parseVisibleMessages()) {
        if (isAtOrAfterBoundary(message, boundary)) messages.set(message.id, message);
      }
      reachedBottom = scrollNewer(scroller);
      passes += 1;
      await sleep(jitter(passes));
    }
    return [...messages.values()].sort(compareMessages);
  }

  function findOldestUnreadBoundary(marker) {
    if (!marker || !document.contains(marker)) return null;
    const oldest = parseVisibleMessages({ marker })
      .filter((message) => message.isAfterUnreadMarker)
      .sort(compareMessages)[0];
    if (!oldest) return null;
    return {
      timestampMs: Date.parse(oldest.timestamp || ""),
      messageId: oldest.id
    };
  }

  function isAtOrAfterBoundary(message, boundary) {
    const messageTime = Date.parse(message.timestamp || "");
    if (!Number.isFinite(messageTime) || !Number.isFinite(boundary.timestampMs)) return compareMessageIds(message.id, boundary.messageId) >= 0;
    if (messageTime > boundary.timestampMs) return true;
    if (messageTime < boundary.timestampMs) return false;
    return compareMessageIds(message.id, boundary.messageId) >= 0;
  }


  function parseVisibleMessages({ marker = null } = {}) {
    const nodes = visibleMessageNodes();
    const authorContext = { author: "Unknown", authorId: "", avatarUrl: "" };
    const identityByAvatar = collectVisibleAuthorIdentities(nodes);
    return nodes
      .map((node) => parseMessageNode(node, { marker, authorContext, identityByAvatar }))
      .filter(Boolean);
  }

  function visibleMessageNodes() {
    return [...document.querySelectorAll(SELECTORS.messageNode)].filter(isMessageNode);
  }

  function isMessageNode(node) {
    return Boolean(
      node.querySelector('[id^="message-content-"], [id^="message-username-"], time[datetime]') ||
        node.matches('[id*="chat-messages-"][id*="message-content-"]')
    );
  }

  function parseMessageNode(node, { marker = null, authorContext = null, identityByAvatar = new Map() } = {}) {
    const id = messageIdForNode(node);
    const authorNode = findMessageAuthorNode(node);
    const timeNode = pick(node, ["time[datetime]", "time"]);
    const contentNode = findMessageContentNode(node, id);
    const avatar = pick(node, ['img[class*="avatar"]', 'img[alt*="avatar"]']);
    const attachmentNodes = [...node.querySelectorAll('a[href], img[src], video source[src], audio source[src]')].filter(
      (item) => !isReplyPreviewNode(item)
    );
    const attachments = attachmentNodes
      .map((item) => attachmentFromNode(item))
      .filter((attachment, index, list) => attachment.url && list.findIndex((other) => other.url === attachment.url) === index);
    const reactions = [...node.querySelectorAll('[aria-label*="reaction" i], [class*="reaction"]')]
      .map((reaction) => reaction.getAttribute("aria-label") || reaction.textContent?.trim())
      .filter(Boolean);

    const timestamp = timeNode?.getAttribute("datetime") || inferTimestampFromSnowflake(id);
    const text = normalizeText(contentNode?.innerText || "");
    if (!text && attachments.length === 0 && !timestamp) return null;

    const explicitAuthor = normalizeText(authorNode?.textContent || "");
    const explicitAuthorId = extractAuthorId(authorNode);
    const explicitAvatarUrl = avatar?.src || "";
    const avatarIdentity = explicitAvatarUrl ? identityByAvatar.get(explicitAvatarUrl) : null;
    const author = explicitAuthor || avatarIdentity?.author || authorContext?.author || "Unknown";
    const authorId = explicitAuthorId || avatarIdentity?.authorId || authorContext?.authorId || "";
    const avatarUrl = explicitAvatarUrl || authorContext?.avatarUrl || "";

    if (authorContext && (explicitAuthor || explicitAuthorId || explicitAvatarUrl)) {
      authorContext.author = author;
      authorContext.authorId = authorId;
      authorContext.avatarUrl = avatarUrl;
    }

    return {
      id,
      author,
      authorId,
      avatarUrl,
      timestamp,
      text,
      attachments,
      embeds: collectEmbeds(node),
      reactions,
      isSystem: Boolean(node.querySelector('[class*="systemMessage"]')),
      isAfterUnreadMarker: isAfterUnreadMarker(node, marker),
      permalink: location.href
    };
  }

  function detectActiveServerId() {
    const match = location.pathname.match(new RegExp("^/channels/([^/]+)(?:/|$)"));
    return match && match[1] !== "@me" ? match[1] : "";
  }

  function upsertActiveServer(servers, activeServerId) {
    if (!activeServerId) return servers;
    const activeName = detectActiveServerName();
    const existing = servers.find((server) => server.id === activeServerId);
    const activeServer = {
      ...(existing || {}),
      id: activeServerId,
      name: activeName || existing?.name || "Current server",
      href: existing?.href || location.origin + "/channels/" + activeServerId,
      elementSelector: existing?.elementSelector || "",
      unread: Boolean(existing?.unread),
      mentions: existing?.mentions || 0,
      active: true
    };
    return [activeServer, ...servers.filter((server) => server.id !== activeServerId)];
  }

  function collectServers(activeServerId = "") {
    return [...document.querySelectorAll(SELECTORS.guildLinks)]
      .map((anchor, index) => {
        const path = new URL(anchor.href, location.origin).pathname;
        const match = path.match(new RegExp("^/channels/([^/]+)/?$"));
        if (!match || match[1] === "@me") return null;
        return {
          id: match[1],
          name: readableServerLabel(anchor) || "Server " + (index + 1),
          href: anchor.href,
          elementSelector: selectorFor(anchor),
          unread: hasUnread(anchor),
          mentions: mentionCount(anchor),
          active: match[1] === activeServerId
        };
      })
      .filter(Boolean)
      .filter((server, index, list) => list.findIndex((item) => item.id === server.id) === index)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  function collectVisibleChannels() {
    return [...document.querySelectorAll(SELECTORS.channelLinks)]
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
          muted: isMuted(anchor),
          unread: hasUnread(anchor),
          mentions: mentionCount(anchor)
        };
      })
      .filter(Boolean)
      .filter((channel, index, list) => list.findIndex((item) => item.id === channel.id) === index);
  }

  function findMessageScroller() {
    const list = document.querySelector(SELECTORS.messageList);
    return list?.closest('[class*="scroller"]') || list?.parentElement || document.scrollingElement;
  }

  async function scrollToUnreadMarker() {
    const scroller = findMessageScroller();
    for (let pass = 0; pass < 50; pass += 1) {
      const marker = findUnreadMarker();
      if (marker) {
        marker.scrollIntoView({ block: "center" });
        await sleep(700);
        return findUnreadMarker() || marker;
      }
      if (!scrollOlder(scroller)) break;
      await sleep(jitter(pass));
    }
    return null;
  }

  function findUnreadMarker() {
    const scroller = findMessageScroller();
    if (!scroller) return null;
    const candidates = [
      ...scroller.querySelectorAll(SELECTORS.unreadMarkerCandidate)
    ];
    return candidates.find(isUnreadMarkerNode) || null;
  }

  function isUnreadMarkerNode(node) {
    const label = normalizeText(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`);
    const text = normalizeText(node.textContent || "");
    const classText = classNameOf(node);
    const markerShape =
      node.getAttribute("role") === "separator" ||
      /divider|separator|isUnread|unreadPill|unreadPillCap|newMessages/i.test(classText) ||
      /\bnew messages\b/i.test(label);
    if (!markerShape) return false;
    return (
      /\b(new messages|unread)\b/i.test(`${label} ${text}`) ||
      (/\bnew\b/i.test(`${label} ${text}`) && /divider|separator|unread/i.test(classText)) ||
      /isUnread|unreadPill|unreadPillCap|divider.*unread|unread.*divider/i.test(classText)
    );
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
      if (findMessageScroller() && document.querySelector(SELECTORS.messageReady)) return;
      await sleep(250);
    }
  }

  async function waitWhilePaused() {
    while (paused && !cancelled) await sleep(250);
  }

  function progress(stage, percent, messages, media, delayMs) {
    chrome.runtime.sendMessage({ type: MSG.CONTENT_PROGRESS, payload: { stage, percent, messages, media, delayMs } }).catch(() => {});
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

  function isAfterUnreadMarker(node, marker = null) {
    const unreadMarker = marker || findUnreadMarker();
    if (!unreadMarker) return false;
    return isUnreadMessageNode(node, unreadMarker);
  }

  function isUnreadMessageNode(node, marker) {
    if (!marker || !document.contains(marker)) return false;
    const position = marker.compareDocumentPosition(node);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return false;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return true;

    let current = node;
    while (current?.previousElementSibling) {
      current = current.previousElementSibling;
      if (current === marker || current.contains(marker)) return true;
    }
    return isVisuallyBelowMarker(node, marker);
  }

  function isVisuallyBelowMarker(node, marker) {
    const markerRect = marker.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (!markerRect.height && !nodeRect.height) return false;
    return nodeRect.top >= markerRect.top - 2 || nodeRect.bottom >= markerRect.bottom - 2;
  }

  function messageIdForNode(node) {
    const rawId = node.id || node.getAttribute("data-list-item-id") || "";
    const rawSnowflakes = rawId.match(/\d{15,}/g);
    if (rawSnowflakes?.length) return rawSnowflakes[rawSnowflakes.length - 1];

    const contentId = findMessageContentNode(node)?.id || "";
    const contentSnowflake = contentId.match(/message-content-(\d{15,})/);
    if (contentSnowflake) return contentSnowflake[1];

    const timestamp = node.querySelector("time[datetime]")?.getAttribute("datetime") || "";
    const author = findMessageAuthorNode(node)?.textContent || "";
    const text = findMessageContentNode(node)?.textContent || node.textContent || "";
    return stableHash(`${timestamp}|${author}|${normalizeText(text)}`);
  }

  function findMessageContentNode(node, messageId = "") {
    if (messageId) {
      const exact = node.querySelector(`#message-content-${CSS.escape(messageId)}`);
      if (exact && !isReplyPreviewNode(exact)) return exact;
    }

    return [...node.querySelectorAll(SELECTORS.messageContentOrMarkup)].find((candidate) => !isReplyPreviewNode(candidate)) || null;
  }

  function collectVisibleAuthorIdentities(nodes) {
    const identities = new Map();
    for (const node of nodes) {
      const authorNode = findMessageAuthorNode(node);
      const author = normalizeText(authorNode?.textContent || "");
      const avatarUrl = pick(node, ['img[class*="avatar"]', 'img[alt*="avatar"]'])?.src || "";
      if (!author || !avatarUrl || identities.has(avatarUrl)) continue;
      identities.set(avatarUrl, { author, authorId: extractAuthorId(authorNode), avatarUrl });
    }
    return identities;
  }

  function findMessageAuthorNode(node) {
    return [
      ...node.querySelectorAll(`${SELECTORS.messageUsername}, [class*="username"], h3 [class*="username"], h3 span`)
    ].find((candidate) => !isReplyPreviewNode(candidate)) || null;
  }

  function isReplyPreviewNode(node) {
    let current = node;
    while (current && current !== document.body) {
      const classText = classNameOf(current);
      if (/repliedMessage|replyBar|replyAvatar|replyBadge|replyContent|threadMessageAccessory|referencedMessage/i.test(classText)) return true;
      if (current.getAttribute("aria-label")?.match(/reply/i)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function extractAuthorId(authorNode) {
    const id = authorNode?.id || authorNode?.closest?.('[id^="message-username-"]')?.id || "";
    return id.match(/(\d{12,})/)?.[1] || "";
  }

  function inferTimestampFromSnowflake(id) {
    const match = String(id).match(/(\d{15,})/);
    if (!match) return "";
    const snowflake = BigInt(match[1]);
    const discordEpoch = 1420070400000n;
    return new Date(Number((snowflake >> 22n) + discordEpoch)).toISOString();
  }

  function parseDateTimeInput(value) {
    if (!value) return null;
    const normalized = String(value).includes("T") ? String(value) : `${value}T00:00`;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function detectActiveChatName() {
    return normalizeText(
      document.querySelector('[class*="title"] h1, [data-text-variant="heading-lg/semibold"], h1')?.textContent ||
        document.title.replace(new RegExp("\\s*\\|\\s*Discord.*$"), "") ||
        "Active chat"
    );
  }

  function detectActiveServerName() {
    const candidates = [
      '[class*="sidebar"] header [class*="name"]',
      '[class*="sidebar"] [class*="guildName"]',
      '[class*="sidebar"] [class*="serverName"]',
      '[class*="guildName"]',
      '[class*="serverName"]'
    ];
    for (const selector of candidates) {
      const value = normalizeText(document.querySelector(selector)?.textContent || "");
      if (value) return value;
    }
    return "Current server";
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

  function readableServerLabel(node) {
    const label = normalizeText(node.getAttribute("aria-label") || node.getAttribute("title") || "");
    return label
      .replace(new RegExp("\\s*,?\\s*\\d+\\s+(unread\\s+)?mentions?.*$", "i"), "")
      .replace(new RegExp("\\s*,?\\s*\\d+\\s+unread.*$", "i"), "")
      .replace(new RegExp("\\s*,?\\s*selected.*$", "i"), "")
      .replace(new RegExp("\\s*,?\\s*server.*$", "i"), "")
      .trim();
  }

  function isMuted(node) {
    const scope = channelStateScope(node);
    const stateText = channelStateText(scope);
    const mutedIcon = scope.some((item) =>
      Boolean(item.querySelector('[aria-label*="muted" i], [class*="muted" i], [class*="modeMuted" i]'))
    );

    return (
      mutedIcon ||
      /(^|\s)(modeMuted|muted|mutedChannel|iconMuted|nameMuted)(\s|$)/i.test(stateText.classText) ||
      /\bmuted\b/i.test(stateText.ariaText)
    );
  }

  function hasUnread(node) {
    if (isMuted(node)) return false;
    const row = channelRowFor(node);
    const stateText = channelStateText(channelStateScope(node));
    const visibleText = normalizeText(row.textContent || "");
    const style = getComputedStyle(node);
    const weight = Number(style.fontWeight) || 0;
    const selected = Boolean(
      node.getAttribute("aria-current") === "page" ||
        node.getAttribute("aria-selected") === "true" ||
        row.querySelector('[aria-current="page"], [aria-selected="true"]')
    );

    return (
      /(^|\s)(modeUnread|unread|unreadImportant|mentionsBadge|numberBadge|newMessages)(\s|$)/i.test(stateText.classText) ||
      /\b(unread|mention|mentions|new messages)\b/i.test(stateText.ariaText) ||
      /\b\d{1,4}\s+(unread|mentions?)\b/i.test(visibleText) ||
      (weight >= 600 && !selected)
    );
  }

  function mentionCount(node) {
    const row = channelRowFor(node);
    const text = `${row.textContent || ""} ${row.getAttribute("aria-label") || ""} ${row.getAttribute("title") || ""}`;
    const mentionMatch = text.match(/(\d{1,4})\s+mentions?/i) || text.match(/mentions?\D+(\d{1,4})/i);
    if (mentionMatch) return Number(mentionMatch[1]);
    const badge = row.querySelector('[class*="numberBadge"], [class*="mentionsBadge"], [aria-label*="mention" i]');
    const badgeMatch = badge?.textContent?.match(/\d{1,4}/);
    return badgeMatch ? Number(badgeMatch[0]) : 0;
  }

  function channelRowFor(node) {
    return (
      node.closest('[data-list-item-id^="channels___"], li, div[role="treeitem"], [class*="containerDefault"]') ||
      node.parentElement ||
      node
    );
  }

  function channelStateScope(node) {
    const scope = [];
    let current = node;
    for (let depth = 0; current && depth < 7; depth += 1) {
      scope.push(current);
      if (current.matches?.('[data-list-item-id^="channels___"], li, div[role="treeitem"], [class*="containerDefault"]')) break;
      current = current.parentElement;
    }
    const row = channelRowFor(node);
    if (!scope.includes(row)) scope.push(row);
    return scope;
  }

  function channelStateText(scope) {
    const allNodes = scope.flatMap((item) => [item, ...item.querySelectorAll("*")]);
    return {
      classText: allNodes.map((item) => classNameOf(item)).join(" "),
      ariaText: allNodes
        .map((item) => `${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`)
        .join(" ")
    };
  }

  function classNameOf(node) {
    if (!node?.className) return "";
    return typeof node.className === "string" ? node.className : node.className.baseVal || String(node.className);
  }

  function parseExcludedChannelNames(value) {
    return new Set(
      String(value || "")
        .split(/[\n,]+/)
        .map((name) => normalizeChannelName(name))
        .filter(Boolean)
    );
  }

  function normalizeChannelName(name) {
    return normalizeText(String(name || "").replace(/#|\(.*?\)/g, "")).toLowerCase();
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
    const timestampCompare = String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
    return timestampCompare || compareMessageIds(a.id, b.id);
  }

  function compareMessageIds(a, b) {
    const aBig = /^\d+$/.test(String(a)) ? BigInt(a) : null;
    const bBig = /^\d+$/.test(String(b)) ? BigInt(b) : null;
    if (aBig !== null && bBig !== null) return aBig > bBig ? 1 : aBig < bBig ? -1 : 0;
    return String(a || "").localeCompare(String(b || ""));
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
