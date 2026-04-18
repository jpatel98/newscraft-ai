# NewsCraft AI

NewsCraft AI is a newsroom collaboration workspace built with Next.js and the OpenAI Agents SDK. The product direction is a Slack-style environment where producers can talk in channels, at-mention agents, and use slash commands to trigger newsroom workflows.

## What is built right now

- A newsroom workspace UI with:
  - channel navigation
  - agent members
  - a shared conversation feed
  - a right-hand context sidebar
- At-mention routing with `@expertise-finder`
- Slash commands:
  - `/expert` for broad expert discovery
  - `/scan-site` for site-scoped expert discovery
- An `Expertise Finder` agent powered by `@openai/agents`
- Hosted OpenAI web search
- Local function tools that can inspect a public webpage and probe likely expert-directory pages on a scoped site
- Structured output for:
  - editorial summary
  - expert shortlist
  - booking angles
  - producer next moves
  - watchouts

## Stack

- Next.js 16 App Router
- React 19
- Tailwind CSS 4
- OpenAI Agents SDK for TypeScript
- Zod for agent output validation
- Cheerio for public webpage parsing inside local function tools

## Local setup

1. Copy the environment file and add your key:

```bash
cp .env.example .env.local
```

2. Start the app:

```bash
npm run dev
```

3. Open `http://localhost:3000`

## How to use it

Broad research:

```text
/expert labor economist in Canada who can react to inflation data today
```

Site-scoped research:

```text
/scan-site brookings.edu AI policy expert who can explain copyright fights in news
```

At-mention inside a channel:

```text
@expertise-finder find climate scientists on https://www.utoronto.ca who can explain wildfire smoke risk tonight
```

You can also include `site:domain.com` or paste a URL directly into a normal message to constrain the run.

## Project structure

- `src/components/newsroom-workbench.tsx`
  Main newsroom workspace UI.
- `src/app/api/chat/route.ts`
  Chat and command entrypoint.
- `src/lib/commands.ts`
  Slash-command and at-mention parsing.
- `src/lib/site-scope.ts`
  URL and site-scope parsing helpers.
- `src/lib/agents/expertise-finder.ts`
  Expertise-finder agent definition and tools.

## Notes

- `OPENAI_MODEL` defaults to `gpt-5.4-mini`
- The expertise finder uses official hosted web search plus local site inspection tools
- The next natural steps are persisted workspaces, real user auth, Slack sync, source lists, and more specialized newsroom agents
