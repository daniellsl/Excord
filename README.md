# Excord Discord Exporter

Excord is a Chrome Extension for Discord Web that exports message history from `https://discord.com/app` into CSV, JSON, or offline HTML. It supports server unread exports, active channel/DM date-time exports, skipped-channel preferences, and optional ZIP packaging with media attachments.

## Features

- Server unread export across detected unread channels in the selected server.
- Active channel or DM export using exact start/end date-time controls.
- CSV export by default, with JSON and HTML options available.
- Optional ZIP packaging for logs and downloaded media attachments.
- Optional media download controls, including images-only and max file size limits.
- Searchable multi-select skipped-channel picker with per-server caching.
- Discord-dark styled offline HTML output.
- Progress updates for scanning, export formatting, media downloading, ZIP packaging, and delays.
- Copy/paste AI analysis prompt for exported Discord logs.

## Install Locally in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

```text
/Users/daniellau/GitHub/Excord
```

5. Open or refresh `https://discord.com/app`.
6. Pin Excord from Chrome's extension menu if you want quick access.

After pulling or changing code, click the refresh button for Excord on `chrome://extensions`.

## Usage

### Server Unread Export

1. Open Discord Web and select the server you want to export from.
2. Open the Excord popup.
3. Choose **Server Unread Export**.
4. Select the target server.
5. Choose the channel scope:
   - **Unread channels in selected server** for unread-only export.
   - **All visible channels in selected server** when you want to export loaded visible channels.
6. Use **Skip channels** to exclude channels. Selected skips are cached per server.
7. Choose the export format. CSV is selected by default.
8. Click **Start Export**.

### Channel Date Export

1. Open the Discord channel or DM you want to export.
2. Open the Excord popup.
3. Choose **Channel Date Export**.
4. Set the start and end date/time.
5. Choose CSV, JSON, or HTML.
6. Click **Start Export**.

### Media and ZIP Options

- **Package output and attachments into a ZIP archive** is enabled by default.
- **Download media attachments** is disabled by default.
- Enable media downloads only when you need offline images/videos/files in the ZIP.
- Use **Images only** and **Max media size** to reduce download size and memory usage.

## AI Analysis Prompt

After exporting Discord messages, you can use the prompt in:

[docs/discord-analysis-prompt.md](docs/discord-analysis-prompt.md)

Paste that prompt into an AI agent with your exported CSV or JSON to get:

- Awareness brief.
- Per-channel summary tables.
- Action items.
- Mentions and replies that may need attention.
- Decisions and open questions.
- Risks and follow-ups.
- Suggested reply drafts.
- Data quality notes.

## Export Notes and Limitations

- Excord reads Discord Web DOM state. Discord UI changes may require parser updates.
- Server unread export opens target channels to scrape them. Discord may mark channels as read.
- Unread boundaries depend on Discord's visible unread marker and loaded message history.
- Very large exports or media-heavy channels may take time and may hit browser memory constraints.
- Media downloads use authenticated browser/background fetches where possible, but expired CDN URLs or large files may fail.
- Author, reply, attachment, and reaction parsing is best-effort because Discord's DOM is not a public export API.

## Architecture Notes

Excord is split by Chrome Extension responsibility:

- `popup.js` owns UI state, form values, progress rendering, and user interactions.
- `background.js` owns long-running export orchestration, file formatting, ZIP creation, media download, and Chrome downloads.
- `content.js` owns Discord Web DOM inspection, channel/server detection, scrolling, and message parsing.
- `shared/messages.js` owns Chrome runtime message names used across scripts. Update this file first when adding a new popup/background/content message.

Keep Discord DOM selectors in `content.js` near the `SELECTORS` constant, and prefer adding parser helpers instead of embedding fragile selectors inside export loops.

## Project Structure

```text
manifest.json                 Chrome Extension Manifest V3 config
popup.html                    Extension popup markup
popup.css                     Popup styling
popup.js                      Popup UI state and event handling
content.js                    Discord Web DOM extraction engine
background.js                 Export pipeline, formatting, ZIP/media/download handling
vendor/jszip-lite.js          Local ZIP compression dependency
shared/messages.js            Cross-script Chrome message constants
icons/                        Extension icon source and PNG sizes
docs/discord-analysis-prompt.md  Copy/paste AI analysis prompt
```

## Development

This project uses vanilla JavaScript, HTML, and CSS. There is no build step.

Useful checks:

```bash
node --check popup.js
node --check content.js
node --check background.js
```

Commit messages should follow Conventional Commits, for example:

```text
fix: exclude reply preview content
feat: add extension icon
docs: add discord analysis prompt
```
