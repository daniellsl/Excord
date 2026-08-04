# Excord Discord Exporter

Excord is a Manifest V3 Chrome Extension for exporting Discord Web messages from `https://discord.com/app` to CSV, JSON, or offline HTML. CSV is the default format.

## What It Does

- Exports unread messages across channels in a selected server.
- Exports the active channel or DM by exact start/end date-time.
- Optionally packages logs and media attachments into a ZIP.
- Supports skipped-channel selection with per-server caching.
- Includes a reusable AI analysis prompt for exported logs.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/Users/daniellau/GitHub/Excord`.
5. Open or refresh `https://discord.com/app`.

After code changes, refresh Excord from `chrome://extensions`.

## Use

### Server Unread Export

1. Select a Discord server in Discord Web.
2. Open Excord.
3. Choose **Server Unread Export**.
4. Select the server and optional skipped channels.
5. Click **Start Export**.

### Channel Date Export

1. Open a Discord channel or DM.
2. Open Excord.
3. Choose **Channel Date Export**.
4. Set start/end date-time.
5. Click **Start Export**.

Media downloading is optional and disabled by default. ZIP packaging is enabled by default.

## AI Analysis Prompt

Use [docs/discord-analysis-prompt.md](docs/discord-analysis-prompt.md) with an exported CSV or JSON file to ask an AI agent for summaries, action items, risks, decisions, open questions, and suggested replies.

## Limitations

- Excord scrapes Discord Web DOM state, so Discord UI changes may require parser updates.
- Server unread export opens target channels and may mark them as read.
- Unread export depends on Discord's visible unread marker and loaded message history.
- Large exports or media-heavy channels may be slow or memory intensive.
- Message parsing is best-effort because Discord does not expose this as a public export API.

## Development

No build step is required.

```bash
node --check popup.js
node --check content.js
node --check background.js
node --check shared/messages.js
```

Key files:

```text
popup.js              Popup UI and user actions
background.js         Export pipeline, ZIP/media/download handling
content.js            Discord DOM extraction and parsing
shared/messages.js    Cross-script Chrome message constants
docs/                 User-facing prompts and docs
icons/                Extension icon assets
```

Use Conventional Commits for commit messages.
