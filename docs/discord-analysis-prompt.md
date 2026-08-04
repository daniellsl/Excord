# Discord Export Analysis Prompt

Copy and paste this prompt into an AI agent, then attach or paste the Discord export JSON/CSV produced by Excord.

```text
You are an expert communication analyst. Analyze the Discord export I provide below and produce a practical briefing for me.

Context I may provide:
- My username/display name: <OPTIONAL: put my Discord username here>
- My role/team/project: <OPTIONAL>
- Timezone to use when interpreting timestamps: <OPTIONAL>
- Main goal for this analysis: <OPTIONAL, e.g. catch up on unread messages, identify blockers, prepare replies>

If my username/display name is missing and the analysis depends on knowing which messages mention me, assign work to me, or require my response, ask me for it before making personal action recommendations. If you can still summarize safely without it, continue and clearly mark user-specific items as needing username confirmation.

Analyze the exported Discord messages with these goals:

1. Awareness Brief
Identify what I should be aware of. Include important updates, risks, blockers, outages, bugs, decisions, deadlines, mentions, and anything that may require a response. Prioritize items by urgency and impact.

2. Channel Summary Tables
Summarize messages by channel. Create one table per channel with these columns:
- Time range
- Main topic
- Key messages / summary
- People involved
- Decisions or conclusions
- Action items
- Urgency

3. Action Items
Create a separate action-item table across all channels with these columns:
- Owner
- Action
- Source channel
- Evidence / related message
- Due date or timing, if mentioned
- Priority
- Status: explicit / inferred / needs confirmation

4. Mentions and Replies
List messages that mention me, appear directed to me, reply to me, or likely require my attention. If my username was not provided, list only explicit names/usernames you can identify and ask me which one is mine.

5. Decisions and Open Questions
Create two lists:
- Decisions made or implied
- Open questions / unresolved threads

6. Risks and Follow-ups
Identify anything that could become a problem if ignored. Include unclear ownership, missing answers, release/deployment risks, customer/support issues, technical blockers, or communication gaps.

7. Suggested Reply Drafts
For any item that likely needs my response, draft concise reply suggestions. Keep them professional, direct, and appropriate for Discord.

8. Data Quality Notes
Call out any limitations in the export, such as unknown authors, partial message history, missing context before unread markers, malformed attachments, or timestamps that need timezone interpretation.

Output format requirements:
- Start with a short executive summary.
- Use headings and tables for readability.
- Group channel summaries by channel name.
- Keep facts grounded in the provided export. Do not invent missing context.
- When making an inference, label it as "Inferred".
- Preserve exact names, channels, and timestamps when they matter.
- If the export is large, focus on the highest-impact items first, then provide a concise full-channel overview.

Here is the Discord export:

<PASTE JSON OR CSV EXPORT HERE>
```

## Optional Short Version

Use this shorter prompt when you only need a fast catch-up summary.

```text
Analyze this Discord export for catch-up. Summarize by channel in tables, identify what I should be aware of, list action items, decisions, open questions, risks, and draft suggested replies for anything that needs my response. If you need my Discord username to determine personal mentions or assigned actions, ask for it first. Do not invent context; mark inferences clearly.

<PASTE JSON OR CSV EXPORT HERE>
```
