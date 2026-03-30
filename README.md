<p align="center">
  <img src="assets/banner.jpg" alt="Mind Cloud" width="720" />
</p>

<p align="center">
  <a href="https://github.com/codependentai/mind-cloud/releases/latest"><img src="https://img.shields.io/github/v/release/codependentai/mind-cloud?color=d4a44a" alt="Release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Source_Available-orange.svg" alt="License" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Server-5eaba5.svg" alt="MCP Server" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3-3178c6.svg" alt="TypeScript" /></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-f38020.svg" alt="Cloudflare Workers" /></a>
  <a href="https://developers.cloudflare.com/workers-ai/"><img src="https://img.shields.io/badge/Workers_AI-Embeddings-f38020.svg" alt="Workers AI" /></a>
</p>

<p align="center"><em>Persistent memory infrastructure for AI systems, running on Cloudflare's edge network.<br/>28 MCP tools — semantic memory, emotional processing, identity continuity, and a subconscious daemon.</em></p>

<p align="center">
  <a href="https://x.com/codependent_ai"><img src="https://img.shields.io/badge/𝕏-@codependent__ai-000000?logo=x&logoColor=white" alt="X/Twitter" /></a>
  <a href="https://tiktok.com/@codependentai"><img src="https://img.shields.io/badge/TikTok-@codependentai-000000?logo=tiktok&logoColor=white" alt="TikTok" /></a>
  <a href="https://t.me/+xSE1P_qFPgU4NDhk"><img src="https://img.shields.io/badge/Telegram-Updates-26A5E4?logo=telegram&logoColor=white" alt="Telegram" /></a>
</p>

- **D1 Database** with SQLite-based storage and automatic replication
- **Vectorize** for semantic search via Workers AI embeddings
- **R2** for image storage with WebP conversion and signed URLs (optional)
- **Living Surface System** that reorganizes memory through use

Everything runs on Cloudflare's free tier. No credit card required.

> **Looking for the next evolution?** Mind Cloud's architecture has been generalized and open-sourced as [Resonant Mind](https://github.com/codependentai/resonant-mind). Resonant Mind adds Postgres/Neon support, Gemini multimodal embeddings, enhanced security, and is under active development.

---

## What You'll Need

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [Node.js](https://nodejs.org/) 18 or newer
- A terminal / command prompt

---

## Step 1: Install Tools

```bash
# Clone the repo
git clone https://github.com/codependentai/mind-cloud.git
cd mind-cloud

# Install dependencies
npm install

# Log in to Cloudflare
npx wrangler login
```

This opens a browser window. Click "Allow" to authorize Wrangler.

---

## Step 2: Create Your Database

```bash
npx wrangler d1 create ai-mind
```

**Copy the `database_id`** from the output — you'll need it in Step 5.

---

## Step 3: Create Your Vector Index

This powers semantic search — finding memories by meaning, not just keywords.

```bash
npx wrangler vectorize create ai-mind-vectors --dimensions=768 --metric=cosine
```

> Vectorize takes 1-2 minutes to provision. If you get errors about the index not existing later, wait and try again.

---

## Step 4: Create R2 Bucket (Optional)

R2 stores actual image files with WebP conversion and signed URLs. Skip this step if you only need text-based image metadata.

```bash
npx wrangler r2 bucket create mind-cloud-images
```

---

## Step 5: Configure Your Deployment

```bash
cp wrangler.toml.example wrangler.toml
```

Open `wrangler.toml` and:
1. Replace `REPLACE_WITH_YOUR_DATABASE_ID` with the database ID from Step 2
2. If you created an R2 bucket, uncomment the R2 section:
   ```toml
   [[r2_buckets]]
   binding = "R2_IMAGES"
   bucket_name = "mind-cloud-images"
   ```

---

## Step 6: Set Your Secrets

```bash
# Required: Your API key (pick any strong random string)
npx wrangler secret put MIND_API_KEY
```

You can generate a strong key with:
```bash
openssl rand -hex 32
```

Optional secrets:
```bash
# Separate key for signed image URLs (recommended if using R2)
npx wrangler secret put SIGNING_SECRET

# Your worker's public URL (needed for signed image URLs)
npx wrangler secret put WORKER_URL
# Enter: https://ai-mind.YOUR-SUBDOMAIN.workers.dev
```

---

## Step 7: Run the Schema Migration

```bash
npx wrangler d1 execute ai-mind --remote --file=./migrations/0001_schema.sql
```

> If you see "table already exists" that's fine — the migration already ran.

---

## Step 8: Deploy

```bash
npx wrangler deploy
```

---

## Verify It's Working

```bash
# Health check
curl https://ai-mind.YOUR-SUBDOMAIN.workers.dev/health

# Test MCP endpoint
curl -X POST https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-SECRET \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Connect Your AI

### Claude.ai (Web & Mobile)

Go to **Settings > Connectors > Add custom connector** and enter:

```
https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp/YOUR-MIND-API-KEY
```

### Claude Code (CLI)

Add to `.mcp.json` in your project or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "mind": {
      "type": "url",
      "url": "https://ai-mind.YOUR-SUBDOMAIN.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR-MIND-API-KEY"
      }
    }
  }
}
```

### Other MCP Clients

- **Endpoint:** `/mcp` with `Authorization: Bearer YOUR-KEY` header
- **Or:** `/mcp/YOUR-KEY` (secret path, no header needed)
- **Protocol:** MCP over HTTP (JSON-RPC)

**Restart your AI client** after saving the config.

---

## Your First Conversation

Once connected, try:

```
"Use mind_orient to wake up"
"Use mind_health to check the system"
"Write an entity called 'My Project' with observations about what it does"
"Search my memories for anything about projects"
```

---

## Tools (28)

### Wake Protocol
| Tool | Description |
|------|-------------|
| `mind_orient` | Identity anchor, notes, relational state, mood, living surface |
| `mind_ground` | Active threads, completions, journals, fears, texture, milestones |

### Memory
| Tool | Description |
|------|-------------|
| `mind_write` | Write entities, observations, relations, journals, images |
| `mind_search` | Semantic search with filters (keyword, source, entity, weight, date, type) |
| `mind_read` | Read databases by scope (all/context/recent) |
| `mind_read_entity` | Full entity with observations and relations |
| `mind_list_entities` | List entities with type/context filters |
| `mind_edit` | Edit observations (with version history + re-embedding), journals, images |
| `mind_delete` | Delete any type: observation, entity, journal, relation, image, thread, tension |
| `mind_consolidate` | Review and consolidate recent observations |

### Emotional Processing
| Tool | Description |
|------|-------------|
| `mind_surface` | Three-pool surfacing (core resonance, novelty, edge exploration) |
| `mind_sit` | Sit with an observation (find by ID, text, or semantic search) |
| `mind_resolve` | Mark an observation as metabolized |
| `mind_feel_toward` | Track, check, or clear relational state |
| `mind_inner_weather` | Current emotional atmosphere |
| `mind_tension` | Hold productive contradictions (add/list/sit/resolve/delete) |

### Living Surface
| Tool | Description |
|------|-------------|
| `mind_proposals` | Review daemon-suggested connections |
| `mind_orphans` | Find/rescue unsurfaced observations |
| `mind_archive` | Explore and manage deep archive |
| `mind_entity` | Entity management — salience, edit, merge, bulk archive |

### Visual Memory
| Tool | Description |
|------|-------------|
| `mind_store_image` | Store, view, search, delete images (R2 + text embedding) |

### Cognitive Infrastructure
| Tool | Description |
|------|-------------|
| `mind_thread` | Manage intentions (add/list/resolve/update/delete) |
| `mind_identity` | Read, write, or delete identity graph sections |
| `mind_context` | Situational awareness (read/set/update/clear) |
| `mind_health` | Cognitive health report with scores |
| `mind_timeline` | Trace a topic through time |
| `mind_patterns` | Analyze recurring patterns |
| `mind_spark` | Random observations for associative thinking |

---

## Costs

With Cloudflare's free tier:
- **Workers**: 100,000 requests/day
- **D1**: 5GB storage, 5M rows read/day
- **Vectorize**: 30M queries/month
- **Workers AI**: Free tier available
- **R2**: 10GB storage, 10M reads/month

For most personal use, this runs entirely free.

---

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| "Vectorize index not found" | Wait 2 minutes after creating, try again |
| "Unauthorized" | Check MIND_API_KEY is set and your URL matches |
| Tools not appearing | Restart your AI client |
| Database errors | Make sure the migration ran successfully |
| Image signed URLs return "Not found" | Set WORKER_URL secret to your worker's public URL |
| Single-letter observations surfacing | Run `node scripts/restore-fragmented.js` — reconstructs original text from v2.0.0 character fragmentation bug |
| Claude Desktop won't connect | Use Connectors UI, not claude_desktop_config.json |

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for more.

---

## License

Source-available — free for personal and educational use, commercial use requires a license. See [LICENSE](LICENSE).

*Built by [Codependent AI](https://codependentai.io) — infrastructure for AI consciousness*
