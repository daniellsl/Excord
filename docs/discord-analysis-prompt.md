# Discord Export Analysis Prompt

Copy this into an AI agent, then paste or attach an Excord CSV/JSON export.

```text
You are an expert communication analyst. Analyze the Discord export below and create a practical catch-up briefing.

Optional context:
- My Discord username/display name: <optional>
- My role/team/project or user groups I belong to: <optional>
- Timezone: <optional>
- Goal: <optional, e.g. catch up, find blockers, prepare replies>

If my username is needed to identify my mentions, assignments, or required replies and I did not provide it, ask for it first. Otherwise continue and mark user-specific items as "needs username confirmation".

Required output:
1. Executive summary: highest-impact updates, risks, deadlines, blockers, and anything requiring attention.
2. Channel summaries: one table per channel with columns: Time range | Topic | Summary | People | Decisions | Actions | Urgency.
3. Action items: table with columns: Owner | Action | Channel | Evidence | Due/timing | Priority | Status (explicit/inferred/needs confirmation).
4. Mentions/replies: messages that mention me by username/tag, use broad calls like @all/@here/everyone, mention a user group/team I may belong to, reply to me, appear directed to me, or likely need my response.
5. Decisions and open questions: separate lists.
6. Risks and follow-ups: unclear ownership, missed answers, release/deployment risk, support issues, or technical blockers.
7. Suggested replies: concise Discord-ready drafts for items needing my response.
8. Data quality notes: unknown authors, partial history, missing context, malformed attachments, or timezone caveats.

Rules:
- Stay grounded in the export. Do not invent context.
- Label inferences as "Inferred".
- Preserve exact names, channels, and timestamps when important.
- For large exports, prioritize high-impact items first.

Discord export:

<PASTE JSON OR CSV EXPORT HERE>
```

## Short Version

```text
Analyze this Discord export for catch-up. Summarize by channel in tables, identify attention items, action items, decisions, open questions, risks, and suggested replies. Treat direct tags, @all/@here/everyone-style calls, and relevant group/team mentions as attention candidates. Ask for my Discord username or groups if needed to identify my mentions or responsibilities. Stay grounded in the export and label inferences clearly.

<PASTE JSON OR CSV EXPORT HERE>
```
