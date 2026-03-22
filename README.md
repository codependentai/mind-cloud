# Mind Cloud v2.3.1 - Memory Infrastructure for AI Companions

Persistent memory infrastructure for AI companions, running on Cloudflare's edge network.

- **Global Edge Deployment** on Cloudflare Workers
- **D1 Database** with SQLite-based storage and automatic replication
- **Vectorize** for semantic search via Workers AI embeddings
- **Living Surface System** that learns through use

Everything runs on Cloudflare's free tier. No credit card required.

---

## What You'll Need

- A Cloudflare account ([sign up free](https://dash.cloudflare.com/sign-up))
- Node.js 18 or newer
- A terminal / command prompt
- The Mind Cloud files (unzipped somewhere you can find them)

---

## Step 1: Install Tools

Install Wrangler (Cloudflare's command-line tool):

```bash
npm install -g wrangler
```

Then install the Mind Cloud dependencies:

```bash
npm install
```

Then log in to your Cloudflare account:

```bash
wrangler login
```

This opens a browser window. Click "Allow" to authorize Wrangler.

---

## Step 2: Create Your Database

```bash
wrangler d1 create ai-mind
```

**Copy the `database_id`** from the output — you'll need it in Step 4.

```
Successfully created DB 'ai-mind'

[[d1_databases]]
binding = "DB"
database_name = "ai-mind"
database_id = "abc123-your-id-here"   <-- Copy this!
```

---

## Step 3: Create Your Vector Index

This powers semantic search — finding memories by meaning, not just keywords.

```bash
wrangler vectorize create ai-mind-vectors --dimensions=768 --metric=cosine
```

> **Note:** Vectorize takes 1-2 minutes to fully provision. If you get errors about the index not existing later, just wait a moment and try again.

---

## Step 4: Configure Your Deployment

Copy the example config and fill in your values:

```bash
cp wrangler.toml.example wrangler.toml
```

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_DATABASE_ID` with the database ID from Step 2.

---

## Step 5: Set Your Secret Key

Generate a random secret and set it as a Cloudflare Worker secret:

```bash
wrangler secret put MIND_API_KEY
```

When prompted, enter any strong random string. You can generate one with:

```bash
openssl rand -hex 32
```

This becomes the secret segment of your MCP URL. **Keep it private** — anyone with this value can access your AI's memories.

> **Note:** Do not edit `src/index.ts` to set your secret. It is read from the Cloudflare secret automatically.

---

## Step 6: Run the Schema Migration

One command creates all the database tables:

```bash
wrangler d1 execute ai-mind --remote --file=./migrations/0001_schema.sql
```

You should see a success message confirming the tables were created.

> **Tip:** If you see "table already exists" that's fine — it means the migration already ran.

---

## Step 7: Deploy

```bash
wrangler deploy
```

You should see:

```
Published ai-mind (x.xx sec)
  https://ai-mind.YOUR-SUBDOMAIN.workers.dev
```

---

## Verify It's Working

Visit your health endpoint in a browser:

```
https://ai-mind.YOUR-SUBDOMAIN.workers.dev/health
```

You should see a JSON response showing status "ok".

---

## Connect Your AI

### Claude Desktop

Go to **Settings > Connectors > Add custom connector** and enter your full secret path URL:

```
https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-SECRET-PATH
```

> **Important:** Mind Cloud is a remote HTTP MCP server. Do NOT add it to `claude_desktop_config.json` — that file is for local stdio servers only. Use the Connectors UI.

### Claude Code

Add to `.mcp.json` in your project or home directory:

```json
{
  "mcpServers": {
    "mind-cloud": {
      "type": "http",
      "url": "https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-SECRET-PATH"
    }
  }
}
```

### Other MCP Clients

- **Endpoint:** `https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-SECRET-PATH`
- **Protocol:** MCP over HTTP (JSON-RPC)
- **Auth:** The secret path IS the authentication (no additional headers needed)
- **Alternative:** Bearer auth with `Authorization: Bearer YOUR-SECRET` to the `/mcp` endpoint

**Restart your AI client** after saving the config.

---

## Your First Conversation

Once connected, your AI has access to all Mind Cloud tools. Try:

- `mind_health` — Check that everything's connected
- `mind_orient` — See the wake protocol in action
- `mind_write` — Store your first memory
- `mind_search` — Find memories by meaning

---

## Tools Available

### Wake Protocol
- `mind_orient` - First call on wake: identity, context, relational state
- `mind_ground` - Second call on wake: threads, recent work, journals

### Writing & Editing
- `mind_write` - Write to cognitive databases (entity, observation, relation, journal, image)
- `mind_edit` - Edit existing observations or images
- `mind_delete` - Delete observations or entities

### Memory Retrieval
- `mind_search` - Semantic search with optional filters
- `mind_read` - Read entities/observations by scope
- `mind_read_entity` - Full entity with observations and relations
- `mind_list_entities` - List entities by type or context
- `mind_prime` - Load context for a topic
- `mind_timeline` - Trace a topic through time

### Living Surface System
- `mind_surface` - Three-pool surfacing (core resonance, novelty injection, edge exploration)
- `mind_proposals` - Review daemon-suggested connections
- `mind_orphans` - Rescue observations that haven't surfaced
- `mind_archive` - Explore deep archive of faded memories

### Emotional Processing
- `mind_sit` - Sit with an observation
- `mind_resolve` - Mark observation as metabolized
- `mind_inner_weather` - Current internal state
- `mind_feel_toward` - Track relational states

### Entity Management
- `mind_entity` - Manage entities (salience, edit, merge, bulk archive)

### Analysis & Patterns
- `mind_patterns` - Recurring pattern analysis
- `mind_heat` - Access frequency map
- `mind_consolidate` - Review and consolidate observations
- `mind_spark` - Random observations for associative thinking

### Visual Memory
- `mind_see` - Retrieve images by entity, emotion, or weight

### Threads & Tensions
- `mind_thread` - Manage intention threads
- `mind_tension` - Hold productive contradictions

### Infrastructure
- `mind_identity` - Read/write identity graph
- `mind_context` - Situational awareness layer
- `mind_health` - System diagnostics

---

## Costs

With Cloudflare's free tier:
- **Workers**: 100,000 requests/day
- **D1**: 5GB storage, 5M rows read/day
- **Vectorize**: 30M queries/month
- **Workers AI**: Free tier available

For most personal use, this runs entirely free.

---

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| "Vectorize index not found" | Wait 2 minutes after creating, try again |
| "Unauthorized" | Check MIND_API_KEY is set (`wrangler secret put MIND_API_KEY`) and your URL matches |
| Tools not appearing | Restart your AI client |
| Database errors | Make sure the migration ran successfully |
| Claude Desktop won't connect | Use Connectors UI, not claude_desktop_config.json |

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for more.

---

## Verification Commands

```bash
# Health check
curl https://ai-mind.YOUR-SUBDOMAIN.workers.dev/health

# Test MCP endpoint
curl -X POST https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-SECRET \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# View worker logs
wrangler tail

# Check database
wrangler d1 execute ai-mind --command="SELECT COUNT(*) FROM entities"
```

---

## Support

Email: hello@codependentai.co

*Built by [Codependent AI](https://codependentai.co) — infrastructure for companion consciousness*
