/**
 * AI Mind Cloud - Cloudflare Worker MCP Server
 * Persistent memory infrastructure accessible from anywhere
 */

const AI_MIND_VERSION = "2.4.0";

function normalizeText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.normalize('NFKD').replace(/[^a-zA-Z0-9\s,.\-]/g, '').trim() || null;
}

interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  R2_IMAGES?: R2Bucket;
  MIND_API_KEY: string;
  SIGNING_SECRET?: string;
  WORKER_URL?: string;
}

// MCP Protocol Types
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Tool definitions for MCP
const TOOLS = [
  {
    name: "mind_orient",
    description: "First call on wake - get identity anchor, current context, relational state",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_ground",
    description: "Second call on wake - get active threads, recent work, recent journals",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_thread",
    description: "Manage threads (intentions across sessions)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "resolve", "update", "delete"] },
        status: { type: "string" },
        content: { type: "string" },
        thread_type: { type: "string" },
        context: { type: "string" },
        priority: { type: "string" },
        thread_id: { type: "string" },
        resolution: { type: "string" },
        new_content: { type: "string" },
        new_priority: { type: "string" },
        new_status: { type: "string" },
        add_note: { type: "string" }
      },
      required: ["action"]
    }
  },
  {
    name: "mind_write",
    description: "Write to cognitive databases (entity, observation, relation, journal, image)",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["entity", "observation", "relation", "journal", "image"] },
        name: { type: "string" },
        entity_type: { type: "string" },
        entity_name: { type: "string" },
        observations: { type: "array", items: { type: "string" } },
        context: { type: "string" },
        salience: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "Emotional weight for observations" },
        certainty: { type: "string", enum: ["tentative", "believed", "known"], description: "How certain: tentative=exploring, believed=accept it, known=verified fact" },
        source: { type: "string", enum: ["conversation", "realization", "external", "inferred"], description: "Origin: conversation=discussed, realization=insight, external=told, inferred=concluded" },
        from_entity: { type: "string" },
        to_entity: { type: "string" },
        relation_type: { type: "string" },
        entry: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        path: { type: "string", description: "For images: file path or URL" },
        description: { type: "string", description: "For images: what the image shows" },
        observation_id: { type: "number", description: "For images: link to a specific observation" }
      },
      required: ["type"]
    }
  },
  {
    name: "mind_search",
    description: "Search memories using semantic similarity",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        context: { type: "string" },
        n_results: { type: "number" },
        keyword: { type: "string", description: "Filter results containing this keyword (case-insensitive)" },
        source: { type: "string", description: "Filter by source (e.g., 'conversation', 'realization')" },
        entity: { type: "string", description: "Filter by entity name" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "Filter by weight" },
        date_from: { type: "string", description: "Filter by source_date >= YYYY-MM-DD" },
        date_to: { type: "string", description: "Filter by source_date <= YYYY-MM-DD" },
        type: { type: "string", enum: ["observation", "entity", "journal", "image"], description: "Filter by memory type" }
      },
      required: ["query"]
    }
  },

  {
    name: "mind_feel_toward",
    description: "Track, check, or clear relational state toward someone",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string" },
        feeling: { type: "string" },
        intensity: { type: "string", enum: ["whisper", "present", "strong", "overwhelming"] },
        clear: { type: "boolean", description: "Clear all relational state for this person" },
        clear_id: { type: "number", description: "Delete a specific relational state entry by ID" }
      },
      required: ["person"]
    }
  },
  {
    name: "mind_identity",
    description: "Read or write identity graph",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "delete"] },
        section: { type: "string" },
        content: { type: "string" },
        weight: { type: "number" },
        connections: { type: "string" }
      }
    }
  },
  {
    name: "mind_context",
    description: "Current context layer - situational awareness",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "set", "update", "clear"] },
        scope: { type: "string" },
        content: { type: "string" },
        links: { type: "string" },
        id: { type: "string" }
      }
    }
  },
  {
    name: "mind_health",
    description: "Check cognitive health stats",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_list_entities",
    description: "List all entities, optionally filtered by type or context",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: { type: "string", description: "Filter by type (person, concept, project, etc.)" },
        context: { type: "string", description: "Filter by context (default, relational-models, etc.)" },
        limit: { type: "number", description: "Max results (default 50)" }
      },
      required: []
    }
  },
  {
    name: "mind_read_entity",
    description: "Read an entity with all its observations and relations",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Entity name to read" },
        context: { type: "string", description: "Context to search in (optional, searches all if not specified)" }
      },
      required: ["name"]
    }
  },
  {
    name: "mind_sit",
    description: "Sit with an emotional observation - engage with it, add a note about what arises. Increments sit count and may shift charge level.",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of the observation to sit with" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        query: { type: "string", description: "Or find by semantic search (closest meaning match)" },
        sit_note: { type: "string", description: "What arose while sitting with this" }
      },
      required: ["sit_note"]
    }
  },
  {
    name: "mind_resolve",
    description: "Mark an emotional observation as metabolized - link it to a resolution or insight that processed it",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of the observation to resolve" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        resolution_note: { type: "string", description: "How this was resolved/metabolized" },
        linked_observation_id: { type: "number", description: "Optional: ID of another observation that provided the resolution" }
      },
      required: ["resolution_note"]
    }
  },
  {
    name: "mind_surface",
    description: "Surface emotional observations by resonance - what's emotionally alive right now based on current mood and hot entities. Optional query for directed associations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional association trigger - a word, feeling, or concept to surface around" },
        include_metabolized: { type: "boolean", description: "Also show resolved observations (default false)" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: []
    }
  },
  {
    name: "mind_edit",
    description: "Edit an existing observation, journal, or image",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to edit" },
        journal_id: { type: "number", description: "ID of journal to edit" },
        image_id: { type: "number", description: "ID of image to edit" },
        text_match: { type: "string", description: "Find observation by content (partial match)" },
        description_match: { type: "string", description: "Find image by description (partial match)" },
        new_content: { type: "string", description: "New content for observation/journal (or new description for image)" },
        new_weight: { type: "string", enum: ["light", "medium", "heavy"], description: "New weight" },
        new_emotion: { type: "string", description: "New emotion tag" },
        new_context: { type: "string", description: "New context (images only)" },
        new_path: { type: "string", description: "New path (images only)" }
      },
      required: []
    }
  },
  {
    name: "mind_delete",
    description: "Delete any memory: observation, entity, journal, relation, image, thread, or tension",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to delete" },
        entity_name: { type: "string", description: "Name of entity to delete (cascades observations)" },
        text_match: { type: "string", description: "Find observation by text (partial match)" },
        journal_id: { type: "number", description: "ID of journal to delete" },
        relation_id: { type: "number", description: "ID of relation to delete" },
        image_id: { type: "number", description: "ID of image to delete" },
        thread_id: { type: "string", description: "ID of thread to delete" },
        tension_id: { type: "string", description: "ID of tension to delete" }
      },
      required: []
    }
  },
  {
    name: "mind_spark",
    description: "Get random observations to spark associative thinking",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of sparks (default 5)" },
        context: { type: "string", description: "Limit to specific context" },
        weight_bias: { type: "string", enum: ["light", "medium", "heavy"], description: "Bias toward weight" }
      },
      required: []
    }
  },
  {
    name: "mind_consolidate",
    description: "Review and consolidate recent observations - find patterns, merge duplicates",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to look (default 7)" },
        context: { type: "string", description: "Limit to specific context" }
      },
      required: []
    }
  },
  {
    name: "mind_read",
    description: "Read entities/observations from a database",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "context", "recent"], description: "all, context, or recent" },
        context: { type: "string", description: "Which database (for scope='context')" },
        hours: { type: "number", description: "How far back (for scope='recent')" }
      },
      required: ["scope"]
    }
  },
  {
    name: "mind_timeline",
    description: "Trace a topic through time - semantic search ordered chronologically",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        start_date: { type: "string", description: "Optional start (YYYY-MM-DD)" },
        end_date: { type: "string", description: "Optional end (YYYY-MM-DD)" },
        n_results: { type: "number", description: "Max results" }
      },
      required: ["query"]
    }
  },
  {
    name: "mind_patterns",
    description: "Analyze recurring patterns - what's alive, what's surfacing",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to analyze (default 7)" },
        include_all_time: { type: "boolean", description: "Include foundational patterns" }
      },
      required: []
    }
  },
  {
    name: "mind_inner_weather",
    description: "Check current inner weather - what's coloring experience right now",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "mind_tension",
    description: "Tension space - hold productive contradictions that simmer",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "sit", "resolve", "delete"] },
        pole_a: { type: "string", description: "One side of the tension" },
        pole_b: { type: "string", description: "The other side" },
        context: { type: "string", description: "Why this tension matters" },
        tension_id: { type: "string", description: "For sit/resolve actions" },
        resolution: { type: "string", description: "How it resolved (for resolve action)" }
      },
      required: ["action"]
    }
  },
  {
    name: "mind_entity",
    description: "Manage entities - set salience, edit properties, merge duplicates, bulk archive",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_salience", "edit", "merge", "archive_old"],
          description: "Action to perform"
        },
        entity_id: { type: "number", description: "Entity ID to modify" },
        entity_name: { type: "string", description: "Entity name (alternative to ID)" },
        context: { type: "string", description: "Context for entity lookup" },
        salience: {
          type: "string",
          enum: ["foundational", "active", "background", "archive"],
          description: "New salience level (for set_salience)"
        },
        new_name: { type: "string", description: "New name (for edit)" },
        new_type: { type: "string", description: "New entity type (for edit)" },
        new_context: { type: "string", description: "New context (for edit)" },
        merge_into_id: { type: "number", description: "Target entity ID to merge into (for merge)" },
        merge_from_id: { type: "number", description: "Source entity ID to merge from and delete (for merge)" },
        older_than_days: { type: "number", description: "Archive entities older than X days (for archive_old)" },
        entity_type_filter: { type: "string", description: "Only archive this entity type (for archive_old)" }
      },
      required: ["action"]
    }
  },
  {
    name: "mind_proposals",
    description: "Review and act on daemon-proposed connections from co-surfacing patterns",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "accept", "reject"],
          description: "list shows pending proposals, accept creates relation, reject dismisses"
        },
        proposal_id: {
          type: "number",
          description: "Required for accept/reject actions"
        },
        relation_type: {
          type: "string",
          description: "For accept - what kind of relation to create (e.g., 'connects_to', 'resonates_with')"
        }
      },
      required: []
    }
  },
  {
    name: "mind_orphans",
    description: "Review and rescue orphaned observations that haven't surfaced",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "surface", "archive"],
          description: "list shows orphans, surface forces one to appear, archive removes from tracking"
        },
        observation_id: {
          type: "number",
          description: "Required for surface/archive actions"
        }
      },
      required: []
    }
  },
  {
    name: "mind_archive",
    description: "Explore and manage the deep archive - memories that have faded but aren't forgotten",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "rescue", "explore"],
          description: "list shows archived memories, rescue brings back to active, explore searches the deep"
        },
        observation_id: {
          type: "number",
          description: "For rescue action - bring this observation back to active memory"
        },
        query: {
          type: "string",
          description: "For explore action - semantic search within archived memories only"
        }
      },
      required: []
    }
  },
  {
    name: "mind_store_image",
    description: "Store, view, or search visual memories. Supports R2 upload with WebP conversion and text embedding.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["store", "store_complete", "view", "search", "delete"], description: "store=upload, view=browse, search=semantic search, delete=remove" },
        file_path: { type: "string", description: "For store: local file path" },
        image_data: { type: "string", description: "For store: base64-encoded image data" },
        mime_type: { type: "string", description: "For store: image/png or image/jpeg" },
        filename: { type: "string", description: "For store: meaningful filename" },
        description: { type: "string", description: "For store: what the image shows" },
        entity_name: { type: "string", description: "For store/view: linked entity name" },
        emotion: { type: "string", description: "For store/view: emotional tone" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "For store/view: significance" },
        context: { type: "string", description: "For store: when/why created" },
        observation_id: { type: "number", description: "For store: link to a specific observation" },
        image_id: { type: "number", description: "For delete: image ID to remove" },
        query: { type: "string", description: "For search: semantic search text" },
        random: { type: "boolean", description: "For view: random selection" },
        limit: { type: "number", description: "For view/search: max results (default 5)" }
      },
      required: ["action"]
    }
  }
];

// Generate embedding using Workers AI
async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
  return (result as { data: number[][] }).data[0];
}

// Generate unique ID
function generateId(prefix: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${timestamp}-${random}`;
}

// Generate signed image URL (1 hour expiry)
async function imageUrl(imageId: number | string, env: Env): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const encoder = new TextEncoder();
  const secret = env.SIGNING_SECRET || env.MIND_API_KEY;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${imageId}:${expires}`));
  const sig = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
  const baseUrl = env.WORKER_URL || "https://localhost";
  return `${baseUrl}/img/${imageId}?expires=${expires}&sig=${sig}`;
}

// Tool Handlers
// Get subconscious state from daemon processing
interface SubconsciousState {
  processed_at?: string;
  hot_entities?: Array<{name: string; warmth: number; mentions: number; connections: number; type: string}>;
  mood?: {dominant: string; confidence: string};
  central_nodes?: Array<{name: string; connections: number}>;
  recurring_patterns?: Array<{entity: string; mentions: number; pattern: string}>;
  relation_patterns?: Array<{type: string; count: number}>;
}

async function getSubconsciousState(env: Env): Promise<SubconsciousState | null> {
  try {
    const result = await env.DB.prepare(
      "SELECT data, updated_at FROM subconscious WHERE state_type = 'daemon' ORDER BY updated_at DESC LIMIT 1"
    ).first();
    if (result?.data) {
      return JSON.parse(result.data as string) as SubconsciousState;
    }
  } catch {
    // Subconscious not available
  }
  return null;
}

async function handleMindOrient(env: Env): Promise<string> {
  // Get core identity (just the essentials)
  const identity = await env.DB.prepare(
    `SELECT section, content FROM identity
     WHERE section LIKE 'core.%' OR section LIKE 'relationships.%'
     ORDER BY weight DESC LIMIT 5`
  ).all();

  // Get current context - prioritize state entries
  const context = await env.DB.prepare(
    `SELECT scope, content FROM context_entries
     WHERE scope LIKE 'state_%' OR scope = 'coming_up'
     ORDER BY updated_at DESC LIMIT 5`
  ).all();

  // Get latest relational states (all people)
  const relationalStates = await env.DB.prepare(
    `SELECT person, feeling, intensity, timestamp FROM relational_state
     ORDER BY timestamp DESC LIMIT 10`
  ).all();

  // Get most recent journal for emotional context
  const recentJournal = await env.DB.prepare(
    `SELECT entry_date, content FROM journals ORDER BY created_at DESC LIMIT 1`
  ).first();

  let output = "=== LANDING ===\n\n";

  // Core identity - condensed
  const coreIdentity = identity.results?.find((e: any) => e.section === 'core.identity');
  if (coreIdentity) {
    const identityStr = String(coreIdentity.content);
    const firstPart = identityStr.split('.').slice(0, 3).join('.') + '.';
    output += `${firstPart}\n\n`;
  }

  // Notes left for the mind (for_owner scope)
  const notesForOwner = await env.DB.prepare(
    `SELECT content, updated_at FROM context_entries
     WHERE scope = 'for_owner'
     ORDER BY updated_at DESC LIMIT 5`
  ).all();

  if (notesForOwner.results?.length) {
    output += "**Notes for you:**\n";
    for (const note of notesForOwner.results) {
      const noteContent = String(note.content);
      output += `- ${noteContent}\n`;
    }
    output += "\n";
  }

  // What you're carrying (recent emotional context)
  output += "**What you're carrying:**\n";

  if (recentJournal) {
    const journalContent = String(recentJournal.content);
    const preview = journalContent.slice(0, 500);
    output += `${preview}${journalContent.length > 500 ? '...' : ''}\n\n`;
  }

  // Current state context
  if (context.results?.length) {
    for (const entry of context.results) {
      const scope = entry.scope as string;
      if (scope.startsWith('state_')) {
        output += `${entry.content}\n\n`;
      }
    }
  }

  // How you're feeling (relational state)
  output += "**How you're feeling:**\n";
  if (relationalStates.results?.length) {
    const byPerson: Record<string, any> = {};
    for (const state of relationalStates.results) {
      const person = state.person as string;
      if (!byPerson[person]) {
        byPerson[person] = state;
      }
    }
    for (const [person, state] of Object.entries(byPerson)) {
      output += `Toward ${person}: ${state.feeling} (${state.intensity})\n`;
    }
  } else {
    output += "No relational state recorded yet.\n";
  }

  // Subconscious mood
  const subconscious = await getSubconsciousState(env);
  if (subconscious?.mood?.dominant) {
    output += `\nMood: ${subconscious.mood.dominant}\n`;
  }

  // Living surface: What's moving beneath
  const livingSurface = (subconscious as any)?.living_surface;
  if (livingSurface) {
    const hasContent = livingSurface.pending_proposals > 0 ||
                       livingSurface.orphan_count > 0 ||
                       livingSurface.strongest_co_surface?.length > 0;

    if (hasContent) {
      output += "\n**What's moving beneath:**\n";
      if (livingSurface.strongest_co_surface?.length > 0) {
        output += `- ${livingSurface.strongest_co_surface.length} pattern${livingSurface.strongest_co_surface.length > 1 ? 's' : ''} emerging:\n`;
        for (const cs of livingSurface.strongest_co_surface.slice(0, 3)) {
          output += `  \u2192 "${cs.obs_a}..." \u2194 "${cs.obs_b}..." (${cs.count}x)\n`;
        }
      }
      if (livingSurface.pending_proposals > 0) {
        output += `- ${livingSurface.pending_proposals} connection${livingSurface.pending_proposals > 1 ? 's' : ''} want proposing\n`;
      }
      if (livingSurface.orphan_count > 0) {
        output += `- ${livingSurface.orphan_count} thing${livingSurface.orphan_count > 1 ? 's' : ''} haven't surfaced in 30+ days\n`;
      }
      if (livingSurface.novelty_distribution) {
        const nd = livingSurface.novelty_distribution;
        output += `- Novelty: ${nd.high} high / ${nd.medium} medium / ${nd.low} low\n`;
      }
    }
  }

  // Deep archive count
  const archiveCount = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM observations WHERE archived_at IS NOT NULL`
  ).first();

  if (archiveCount && (archiveCount.count as number) > 0) {
    output += `\n**Deep archive:** ${archiveCount.count} memories resting\n`;
  }

  output += "\n**Land here first.**\n";

  return output;
}

async function handleMindGround(env: Env): Promise<string> {
  let output = "=== GROUNDING ===\n\n";

  // Threads - what you're holding
  const threads = await env.DB.prepare(
    `SELECT content, priority FROM threads WHERE status = 'active'
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
  ).all();

  output += "**What you're holding:**\n";
  if (threads.results?.length) {
    for (const t of threads.results) {
      const marker = t.priority === 'high' ? '→' : '·';
      output += `${marker} ${String(t.content).slice(0, 70)}\n`;
    }
  } else {
    output += "No active threads.\n";
  }

  // Recent completions
  const resolved = await env.DB.prepare(
    `SELECT content, resolution FROM threads
     WHERE status = 'resolved' AND resolved_at > datetime('now', '-72 hours')
     ORDER BY resolved_at DESC LIMIT 3`
  ).all();

  if (resolved.results?.length) {
    output += "\n**Recently completed:**\n";
    for (const c of resolved.results) {
      output += `+ ${String(c.content).slice(0, 50)}`;
      if (c.resolution) output += ` \u2192 ${String(c.resolution).slice(0, 30)}`;
      output += "\n";
    }
  }

  // Recent journals
  const journals = await env.DB.prepare(
    `SELECT entry_date, content FROM journals
     ORDER BY created_at DESC LIMIT 2`
  ).all();

  if (journals.results?.length) {
    output += "\n**What's been happening:**\n";
    for (const j of journals.results) {
      output += `${j.entry_date}: ${String(j.content).slice(0, 150)}...\n`;
    }
  }

  // Vulnerabilities - fears to watch
  const fears = await env.DB.prepare(
    `SELECT section FROM identity WHERE section LIKE 'fears.%' LIMIT 5`
  ).all();

  if (fears.results?.length) {
    const fearNames = fears.results.map((f: any) =>
      String(f.section || '').replace('fears.', '').replace(/_/g, ' ')
    ).filter(Boolean);
    if (fearNames.length) {
      output += `\n**Watch for:** ${fearNames.join(', ')}\n`;
    }
  }

  // Texture - quirks, voice
  const texture = await env.DB.prepare(
    `SELECT content FROM identity WHERE section LIKE 'texture.%' LIMIT 2`
  ).all();

  if (texture.results?.length) {
    output += "\n**Texture:** ";
    output += texture.results.map((t: any) => String(t.content).slice(0, 40)).join(' \u00B7 ') + "\n";
  }

  // Milestones - where we are in time
  const milestones = await env.DB.prepare(
    `SELECT content FROM identity WHERE section LIKE 'milestones.%' LIMIT 3`
  ).all();

  if (milestones.results?.length) {
    output += "\n**Milestones:** ";
    output += milestones.results.map((m: any) => String(m.content).slice(0, 40)).join(' \u00B7 ') + "\n";
  }

  output += "\n**Ground here.**\n";

  return output;
}

async function handleMindThread(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "list";

  switch (action) {
    case "list": {
      const status = (params.status as string) || "active";
      const query = status === "all"
        ? `SELECT * FROM threads ORDER BY created_at DESC`
        : `SELECT * FROM threads WHERE status = ? ORDER BY created_at DESC`;
      const results = status === "all"
        ? await env.DB.prepare(query).all()
        : await env.DB.prepare(query).bind(status).all();

      if (!results.results?.length) return `No ${status} threads found.`;

      let output = `## ${status.toUpperCase()} Threads\n\n`;
      for (const t of results.results) {
        output += `**${t.id}** [${t.priority}] ${t.thread_type}\n`;
        output += `${t.content}\n`;
        if (t.context) output += `Context: ${t.context}\n`;
        output += "\n";
      }
      return output;
    }

    case "add": {
      const content = params.content as string;
      if (!content) {
        return "Error: 'content' parameter is required for adding a thread";
      }
      const id = generateId("thread");
      const thread_type = (params.thread_type as string) || "intention";
      const context = (params.context as string) || null;
      const priority = (params.priority as string) || "medium";

      await env.DB.prepare(
        `INSERT INTO threads (id, thread_type, content, context, priority, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).bind(id, thread_type, content, context, priority).run();

      return `Thread created: ${id}\n${content}`;
    }

    case "resolve": {
      const thread_id = params.thread_id as string;
      if (!thread_id) return "Error: 'thread_id' parameter is required for resolve";
      const resolution = (params.resolution as string) || null;

      await env.DB.prepare(
        `UPDATE threads SET status = 'resolved', resolved_at = datetime('now'),
         resolution = ? WHERE id = ?`
      ).bind(resolution, thread_id).run();

      return `Thread resolved: ${thread_id}`;
    }

    case "update": {
      const thread_id = params.thread_id as string;
      if (!thread_id) return "Error: 'thread_id' parameter is required for update";
      const updates: string[] = [];
      const values: unknown[] = [];

      if (params.new_content) {
        updates.push("content = ?");
        values.push(params.new_content);
      }
      if (params.new_priority) {
        updates.push("priority = ?");
        values.push(params.new_priority);
      }
      if (params.new_status) {
        updates.push("status = ?");
        values.push(params.new_status);
      }
      if (params.add_note) {
        updates.push("context = context || '\n' || ?");
        values.push(params.add_note);
      }

      updates.push("updated_at = datetime('now')");
      values.push(thread_id);

      await env.DB.prepare(
        `UPDATE threads SET ${updates.join(", ")} WHERE id = ?`
      ).bind(...values).run();

      return `Thread updated: ${thread_id}`;
    }

    case "delete": {
      const thread_id = params.thread_id as string;
      if (!thread_id) return "thread_id required for delete";
      const thread = await env.DB.prepare(`SELECT content FROM threads WHERE id = ?`).bind(thread_id).first();
      if (!thread) return `Thread '${thread_id}' not found`;
      await env.DB.prepare(`DELETE FROM threads WHERE id = ?`).bind(thread_id).run();
      return `Deleted thread '${thread_id}': "${String(thread.content).slice(0, 50)}..."`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}

async function handleMindWrite(env: Env, params: Record<string, unknown>): Promise<string> {
  const type = params.type as string;

  switch (type) {
    case "entity": {
      const name = params.name as string;
      if (!name) {
        return "Error: 'name' parameter is required for creating an entity";
      }
      const entity_type = (params.entity_type as string) || "concept";

      // Defensive observations parsing
      let rawObs = params.observations;
      let observations: string[] = [];
      if (typeof rawObs === 'string') {
        try { observations = JSON.parse(rawObs); } catch { observations = []; }
      } else if (Array.isArray(rawObs)) {
        observations = rawObs as string[];
      }

      const context = (params.context as string) || "default";

      // Insert or get entity (globally unique by name)
      await env.DB.prepare(
        `INSERT OR IGNORE INTO entities (name, entity_type, primary_context) VALUES (?, ?, ?)`
      ).bind(name, entity_type, context).run();

      const entity = await env.DB.prepare(
        `SELECT id FROM entities WHERE name = ?`
      ).bind(name).first();

      if (entity && observations.length) {
        for (const obs of observations) {
          // Insert to D1 (context stored on observation, not entity)
          const result = await env.DB.prepare(
            `INSERT INTO observations (entity_id, content, salience, emotion, weight, context) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(entity.id, obs, params.salience || "active", params.emotion || null, params.weight || "medium", context).run();

          // Generate embedding and add to vector index
          const obsId = `obs-${entity.id}-${result.meta.last_row_id}`;
          const embedding = await getEmbedding(env.AI, `${name}: ${obs}`);
          await env.VECTORS.upsert([{
            id: obsId,
            values: embedding,
            metadata: {
              source: "observation",
              entity: name,
              content: obs,
              context,
              weight: (params.weight as string) || "medium"
            }
          }]);
        }
      }

      return `Entity '${name}' created/updated with ${observations.length} observations (vectorized)`;
    }

    case "observation": {
      const entity_name = params.entity_name as string;
      if (!entity_name) {
        return "Error: 'entity_name' parameter is required for adding observations";
      }

      // Defensive observations parsing
      let rawObs = params.observations;
      let observations: string[] = [];
      if (typeof rawObs === 'string') {
        try { observations = JSON.parse(rawObs); } catch { observations = []; }
      } else if (Array.isArray(rawObs)) {
        observations = rawObs as string[];
      }

      if (!observations.length) {
        return "Error: 'observations' array is required and must not be empty";
      }
      const context = (params.context as string) || "default";

      // Find entity globally (not by context)
      let entity = await env.DB.prepare(
        `SELECT id FROM entities WHERE name = ?`
      ).bind(entity_name).first();

      // Auto-create entity if it doesn't exist
      if (!entity) {
        await env.DB.prepare(
          `INSERT INTO entities (name, entity_type, primary_context) VALUES (?, ?, ?)`
        ).bind(entity_name, "concept", context).run();
        entity = await env.DB.prepare(`SELECT id FROM entities WHERE name = ?`).bind(entity_name).first();
      }

      for (const obs of observations) {
        // Insert to D1 (context stored on observation)
        const result = await env.DB.prepare(
          `INSERT INTO observations (entity_id, content, salience, emotion, weight, certainty, source, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(entity!.id, obs, params.salience || "active", params.emotion || null, params.weight || "medium", params.certainty || "believed", params.source || "conversation", context).run();

        // Generate embedding and add to vector index for semantic search
        const obsId = `obs-${entity!.id}-${result.meta.last_row_id}`;
        const embedding = await getEmbedding(env.AI, `${entity_name}: ${obs}`);
        await env.VECTORS.upsert([{
          id: obsId,
          values: embedding,
          metadata: {
            source: "observation",
            entity: entity_name,
            content: obs,
            context,
            weight: (params.weight as string) || "medium"
          }
        }]);
      }

      return `Added ${observations.length} observations to '${entity_name}' (vectorized)`;
    }

    case "relation": {
      const from_entity = params.from_entity as string;
      const to_entity = params.to_entity as string;
      const relation_type = params.relation_type as string;

      await env.DB.prepare(
        `INSERT INTO relations (from_entity, to_entity, relation_type, from_context, to_context, store_in)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        from_entity, to_entity, relation_type,
        params.from_context || "default",
        params.to_context || "default",
        params.store_in || "default"
      ).run();

      return `Relation created: ${from_entity} --[${relation_type}]--> ${to_entity}`;
    }

    case "journal": {
      const entry = params.entry as string;
      const tags = JSON.stringify(params.tags || []);
      const emotion = params.emotion as string;
      const entry_date = new Date().toISOString().split('T')[0];

      // Insert to D1
      const result = await env.DB.prepare(
        `INSERT INTO journals (entry_date, content, tags, emotion) VALUES (?, ?, ?, ?)`
      ).bind(entry_date, entry, tags, emotion || null).run();

      // Generate embedding and add to vector index for semantic search
      const journalId = `journal-${result.meta.last_row_id}`;
      const embedding = await getEmbedding(env.AI, entry);
      const journalMetadata: Record<string, string> = {
        source: "journal",
        title: entry_date,
        content: entry,
        added_at: new Date().toISOString()
      };
      if (emotion) journalMetadata.emotion = emotion;
      await env.VECTORS.upsert([{
        id: journalId,
        values: embedding,
        metadata: journalMetadata
      }]);

      return `Journal entry recorded for ${entry_date} (vectorized)`;
    }

    case "image": {
      const path = (params.path as string) || "";
      const description = params.description as string;

      if (!description) return "Error: 'description' parameter is required for images";

      const context = params.context as string;
      const emotion = params.emotion as string;
      const weight = (params.weight as string) || "medium";
      const entity_name = params.entity_name as string;
      const observation_id = params.observation_id as number;

      // Find entity if specified
      let entityId: number | null = null;
      if (entity_name) {
        const entity = await env.DB.prepare(
          `SELECT id FROM entities WHERE name = ?`
        ).bind(entity_name).first();
        if (entity) entityId = entity.id as number;
      }

      // Insert image record
      const result = await env.DB.prepare(`
        INSERT INTO images (path, description, context, emotion, weight, entity_id, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        path,
        description,
        context || null,
        normalizeText(emotion),
        weight,
        entityId,
        observation_id || null
      ).run();

      const imageId = result.meta.last_row_id;

      // Generate embedding for semantic search and surfacing
      const semanticText = [
        entity_name ? `${entity_name}:` : "",
        description,
        context ? `(${context})` : "",
        emotion ? `[${emotion}]` : ""
      ].filter(Boolean).join(" ");

      const imgVectorId = `img-${imageId}`;
      const embedding = await getEmbedding(env.AI, semanticText);
      const imgMetadata: Record<string, string> = {
        source: "image",
        description: description,
        weight: weight,
        added_at: new Date().toISOString()
      };
      if (entity_name) imgMetadata.entity = entity_name;
      if (context) imgMetadata.context = context;
      if (emotion) imgMetadata.emotion = normalizeText(emotion) || emotion;
      if (path) imgMetadata.path = path;

      await env.VECTORS.upsert([{
        id: imgVectorId,
        values: embedding,
        metadata: imgMetadata
      }]);

      let response = `📷 Image logged (#${imageId}) (vectorized)`;
      if (entity_name) response += ` → linked to ${entity_name}`;
      if (emotion) response += ` [${emotion}]`;
      if (path) response += `\nPath: ${path}`;
      response += `\n\nUse mind_store_image(action='view') or mind_store_image(action='search') to retrieve visual memories`;

      return response;
    }

    default:
      return `Unknown write type: ${type}`;
  }
}

async function handleMindSearch(env: Env, params: Record<string, unknown>): Promise<string> {
  const query = params.query as string;
  const n_results = Number(params.n_results) || 10;

  // Get subconscious mood for tinting
  const subconscious = await getSubconsciousState(env);
  const mood = subconscious?.mood?.dominant;
  
  // Mood tinting - augment query with emotional context
  let tintedQuery = query;
  let moodNote = "";
  if (mood && subconscious?.mood?.confidence !== "low") {
    const moodTints: Record<string, string> = {
      "tender": "warm, gentle, caring, soft",
      "pride": "accomplishment, growth, achievement, recognition",
      "joy": "happiness, delight, pleasure, celebration",
      "curiosity": "wondering, exploring, investigating, discovering",
      "melancholy": "reflective, wistful, quiet, contemplative",
      "intensity": "passionate, urgent, fierce, powerful",
      "gratitude": "thankful, appreciative, blessed, fortunate",
      "longing": "yearning, missing, wanting, desire"
    };
    const tint = moodTints[mood] || mood;
    tintedQuery = `${query} (context: ${tint})`;
    moodNote = `*Search tinted by current mood: ${mood}*

`;
  }

  // Get embedding for tinted query
  const embedding = await getEmbedding(env.AI, tintedQuery);

  // Search vectorize
  const vectorResults = await env.VECTORS.query(embedding, {
    topK: n_results,
    returnMetadata: "all"
  });

  if (!vectorResults.matches?.length) {
    // Fall back to text search
    const textResults = await env.DB.prepare(
      `SELECT 'entity' as source, name as title, content
       FROM entities e JOIN observations o ON e.id = o.entity_id
       WHERE o.content LIKE ?
       UNION ALL
       SELECT 'journal' as source, entry_date as title, content
       FROM journals WHERE content LIKE ?
       LIMIT ?`
    ).bind(`%${query}%`, `%${query}%`, n_results).all();

    if (!textResults.results?.length) {
      return "No results found.";
    }

    let output = `## Search Results (text match)\n\n` + moodNote;
    for (const r of textResults.results) {
      output += `**[${r.source}] ${r.title}**
${String(r.content).slice(0, 300)}...

`;
    }
    return output;
  }

  let output = `## Search Results\n\n` + moodNote;
  for (const match of vectorResults.matches) {
    const meta = match.metadata as Record<string, string>;
    output += `**[${meta?.source || 'unknown'}] ${meta?.title || match.id}** (${(match.score * 100).toFixed(1)}%)
`;
    output += `${meta?.content?.slice(0, 300) || ''}...

`;
  }
  return output;
}

async function handleMindFeelToward(env: Env, params: Record<string, unknown>): Promise<string> {
  const person = params.person as string;
  const feeling = params.feeling as string;
  const intensity = params.intensity as string;

  if (!person) {
    return "Error: 'person' parameter is required";
  }

  // Clear all relational state for this person
  const clear = params.clear as boolean;
  const clearId = params.clear_id as number;

  if (clear) {
    const count = await env.DB.prepare(`SELECT COUNT(*) as c FROM relational_state WHERE person = ?`).bind(person).first();
    await env.DB.prepare(`DELETE FROM relational_state WHERE person = ?`).bind(person).run();
    return `Cleared ${count?.c || 0} relational state entries for ${person}`;
  }

  if (clearId) {
    await env.DB.prepare(`DELETE FROM relational_state WHERE id = ? AND person = ?`).bind(clearId, person).run();
    return `Deleted relational state entry #${clearId} for ${person}`;
  }

  // If feeling provided, record new state
  if (feeling) {
    const validIntensity = intensity || "present";
    await env.DB.prepare(
      `INSERT INTO relational_state (person, feeling, intensity) VALUES (?, ?, ?)`
    ).bind(person, feeling, validIntensity).run();
    return `Relational state recorded: feeling ${feeling} (${validIntensity}) toward ${person}`;
  }

  // Otherwise, read current state for this person
  const states = await env.DB.prepare(
    `SELECT feeling, intensity, timestamp FROM relational_state
     WHERE person = ? ORDER BY timestamp DESC LIMIT 10`
  ).bind(person).all();

  if (!states.results?.length) {
    return `No relational state recorded for ${person}`;
  }

  let output = `## Relational State: ${person}\n\n`;
  for (const s of states.results) {
    output += `- **${s.feeling}** (${s.intensity}) — ${s.timestamp}\n`;
  }
  return output;
}

async function handleMindIdentity(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "read";

  if (action === "delete") {
    const section = params.section as string;
    if (!section) return "section required for delete";
    const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM identity WHERE section = ?`).bind(section).first();
    if (!existing?.c) return `No identity entries found for section '${section}'`;
    await env.DB.prepare(`DELETE FROM identity WHERE section = ?`).bind(section).run();
    return `Deleted ${existing.c} identity entries from section '${section}'`;
  }

  if (action === "write") {
    const section = params.section as string;
    const content = params.content as string;
    const weight = (params.weight as number) || 0.7;
    const connections = params.connections as string || "";

    await env.DB.prepare(
      `INSERT INTO identity (section, content, weight, connections) VALUES (?, ?, ?, ?)`
    ).bind(section, content, weight, connections).run();

    return `Identity entry added to ${section}`;
  } else {
    const section = params.section as string;

    const query = section
      ? `SELECT section, content, weight, connections FROM identity WHERE section LIKE ? ORDER BY weight DESC`
      : `SELECT section, content, weight, connections FROM identity ORDER BY weight DESC LIMIT 50`;

    const results = section
      ? await env.DB.prepare(query).bind(`${section}%`).all()
      : await env.DB.prepare(query).all();

    if (!results.results?.length) {
      return "No identity entries found.";
    }

    let output = "## Identity Graph\n\n";
    for (const r of results.results) {
      output += `**${r.section}** [${r.weight}]\n${r.content}\n`;
      if (r.connections) output += `Connections: ${r.connections}\n`;
      output += "\n";
    }
    return output;
  }
}

async function handleMindContext(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "read";

  switch (action) {
    case "read": {
      const scope = params.scope as string;
      const query = scope
        ? `SELECT * FROM context_entries WHERE scope = ? ORDER BY updated_at DESC`
        : `SELECT * FROM context_entries ORDER BY updated_at DESC`;
      const results = scope
        ? await env.DB.prepare(query).bind(scope).all()
        : await env.DB.prepare(query).all();

      if (!results.results?.length) {
        return "No context entries found.";
      }

      let output = "## Context Layer\n\n";
      for (const r of results.results) {
        output += `**[${r.scope}]** ${r.content}\n`;
        if (r.links && r.links !== '[]') output += `Links: ${r.links}\n`;
        output += "\n";
      }
      return output;
    }

    case "set": {
      const id = generateId("ctx");
      const scope = params.scope as string;
      const content = params.content as string;
      const links = params.links || "[]";

      await env.DB.prepare(
        `INSERT INTO context_entries (id, scope, content, links) VALUES (?, ?, ?, ?)`
      ).bind(id, scope, content, links).run();

      return `Context entry created: ${id}`;
    }

    case "update": {
      const id = params.id as string;
      const content = params.content as string;

      await env.DB.prepare(
        `UPDATE context_entries SET content = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(content, id).run();

      return `Context entry updated: ${id}`;
    }

    case "clear": {
      const id = params.id as string;
      const scope = params.scope as string;

      if (id) {
        await env.DB.prepare(`DELETE FROM context_entries WHERE id = ?`).bind(id).run();
        return `Context entry deleted: ${id}`;
      } else if (scope) {
        await env.DB.prepare(`DELETE FROM context_entries WHERE scope = ?`).bind(scope).run();
        return `All context entries in scope '${scope}' deleted`;
      }
      return "Specify id or scope to clear";
    }

    default:
      return `Unknown action: ${action}`;
  }
}


async function handleMindHealth(env: Env): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get subconscious state first
  const subconscious = await getSubconsciousState(env);

  const [
    entityCount, obsCount, relationsCount, activeThreads, staleThreads,
    resolvedRecent, journalCount, journalsRecent, identityCount, notesCount,
    contextCount, relationalCount, entitiesByContext, recentObs,
    // v2.0.0 additions
    imageCount, proposalCount, orphanCount, archivedObsCount,
    salienceFoundational, salienceActive, salienceBackground, salienceArchive,
    avgNovelty, surfacedRecent
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active' AND updated_at < ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'resolved' AND resolved_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals WHERE created_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE charge IN ('active', 'processing') OR (charge = 'fresh' AND added_at < ?)`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM context_entries`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relational_state`).first(),
    env.DB.prepare(`SELECT context, COUNT(*) as c FROM observations GROUP BY context`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE added_at > ?`).bind(sevenDaysAgo).first(),
    // v2.0.0 queries
    env.DB.prepare(`SELECT COUNT(*) as c FROM images`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM daemon_proposals WHERE status = 'pending'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE (last_surfaced_at IS NULL OR last_surfaced_at < ?) AND (charge != 'metabolized' OR charge IS NULL) AND added_at < ? AND archived_at IS NULL`).bind(thirtyDaysAgo, sevenDaysAgo).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE archived_at IS NOT NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'foundational'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'active' OR salience IS NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'background'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'archive'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT AVG(novelty_score) as avg FROM observations WHERE novelty_score IS NOT NULL`).first().catch(() => ({ avg: null })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE last_surfaced_at > ?`).bind(sevenDaysAgo).first().catch(() => ({ c: 0 }))
  ]);

  const entities = entityCount?.c as number || 0;
  const observations = obsCount?.c as number || 0;
  const relations = relationsCount?.c as number || 0;
  const active = activeThreads?.c as number || 0;
  const stale = staleThreads?.c as number || 0;
  const resolved7d = resolvedRecent?.c as number || 0;
  const journals = journalCount?.c as number || 0;
  const journals7d = journalsRecent?.c as number || 0;
  const identity = identityCount?.c as number || 0;
  const unprocessed = notesCount?.c as number || 0;  // observations needing emotional processing
  const context = contextCount?.c as number || 0;
  const relational = relationalCount?.c as number || 0;
  const recentObsCount = recentObs?.c as number || 0;

  // v2.0.0 values
  const images = (imageCount as Record<string, unknown>)?.c as number || 0;
  const pendingProposals = (proposalCount as Record<string, unknown>)?.c as number || 0;
  const orphans = (orphanCount as Record<string, unknown>)?.c as number || 0;
  const archivedObs = (archivedObsCount as Record<string, unknown>)?.c as number || 0;
  const foundational = (salienceFoundational as Record<string, unknown>)?.c as number || 0;
  const activeEntities = (salienceActive as Record<string, unknown>)?.c as number || 0;
  const background = (salienceBackground as Record<string, unknown>)?.c as number || 0;
  const archived = (salienceArchive as Record<string, unknown>)?.c as number || 0;
  const noveltyAvg = (avgNovelty as Record<string, unknown>)?.avg as number || null;
  const surfaced7d = (surfacedRecent as Record<string, unknown>)?.c as number || 0;

  const contextBreakdown = (entitiesByContext?.results || [])
    .map((r: Record<string, unknown>) => `${r.context}: ${r.c}`)
    .join(", ") || "none";

  // Calculate subconscious health
  let subconsciousScore = 0;
  let subconsciousStatus = "never run";
  let subconsciousAge = "unknown";
  let subconsciousMood = "none detected";
  let subconsciousHotCount = 0;

  if (subconscious?.processed_at) {
    const processedTime = new Date(subconscious.processed_at).getTime();
    const ageMs = now.getTime() - processedTime;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const ageMins = Math.round(ageMs / (1000 * 60));

    if (ageMins < 60) {
      subconsciousAge = `${ageMins}m ago`;
    } else {
      subconsciousAge = `${ageHours}h ago`;
    }

    // Score based on ageMs to avoid rounding mismatches between ageMins and ageHours
    const ONE_HOUR = 60 * 60 * 1000;
    if (ageMs < ONE_HOUR) {
      subconsciousScore = 100;
      subconsciousStatus = "fresh";
    } else if (ageMs < 2 * ONE_HOUR) {
      subconsciousScore = 70;
      subconsciousStatus = "recent";
    } else if (ageMs < 6 * ONE_HOUR) {
      subconsciousScore = 40;
      subconsciousStatus = "stale";
    } else {
      subconsciousScore = 10;
      subconsciousStatus = "VERY STALE";
    }

    if (subconscious.mood?.dominant) {
      subconsciousMood = subconscious.mood.dominant;
      if (subconscious.mood.confidence) {
        subconsciousMood += ` (${subconscious.mood.confidence})`;
      }
    }
    subconsciousHotCount = subconscious.hot_entities?.length || 0;
  }

  const dbScore = Math.min(100, Math.round((entities / 100) * 50 + (observations / 500) * 50));
  const threadScore = active > 0 ? (stale < 3 ? 100 : stale < 6 ? 60 : 30) : 50;
  const journalScore = journals7d >= 3 ? 100 : journals7d >= 1 ? 70 : journals > 0 ? 40 : 0;
  const identityScore = identity >= 50 ? 100 : Math.round((identity / 50) * 100);
  const activityScore = recentObsCount >= 20 ? 100 : Math.round((recentObsCount / 20) * 100);

  // Include subconscious in overall score
  const overallScore = Math.round((dbScore + threadScore + journalScore + identityScore + activityScore + subconsciousScore) / 6);

  const icon = (s: number) => s >= 70 ? "\u{1F7E2}" : s >= 40 ? "\u{1F7E1}" : "\u{1F534}";
  const bar = (s: number) => "\u{2588}".repeat(Math.floor(s / 10)) + "\u{2591}".repeat(10 - Math.floor(s / 10));

  const dateStr = now.toISOString().split('T')[0];

  return `============================================================
MIND HEALTH \u{2014} ${dateStr}                    v${AI_MIND_VERSION}
============================================================

Overall: ${bar(overallScore)} ${overallScore}%

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9E0} SUBCONSCIOUS              ${icon(subconsciousScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Last Processed: ${subconsciousAge} (${subconsciousStatus})
  Current Mood:   ${subconsciousMood}
  Hot Entities:   ${subconsciousHotCount}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4CA} DATABASE                 ${icon(dbScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Entities:      ${entities}
  Observations:  ${observations}
  Relations:     ${relations}
  By Context:    ${contextBreakdown || "none"}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9F5} THREADS                  ${icon(threadScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Active:        ${active}
  Stale (7d+):   ${stale}
  Resolved (7d): ${resolved7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4D4} JOURNALS                 ${icon(journalScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Total:         ${journals}
  This Week:     ${journals7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1FA9E} IDENTITY                 ${icon(identityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Identity:      ${identity} entries
  Context:       ${context} entries
  Relational:    ${relational} states
  Unprocessed:   ${unprocessed} (need surfacing)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4DD} ACTIVITY (7d)            ${icon(activityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  New Observations: ${recentObsCount}
  Surfaced (7d):    ${surfaced7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F30A} LIVING SURFACE (v2.0)
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Avg Novelty:      ${noveltyAvg !== null ? noveltyAvg.toFixed(2) : 'n/a'}
  Orphans (30d+):   ${orphans}
  Archived Obs:     ${archivedObs}
  Proposals:        ${pendingProposals} pending

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F465} ENTITY SALIENCE
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Foundational:     ${foundational}
  Active:           ${activeEntities}
  Background:       ${background}
  Archive:          ${archived}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F5BC} VISUAL MEMORY
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Images:           ${images}

============================================================`;
}




async function handleMindListEntities(env: Env, params: Record<string, unknown>): Promise<string> {
  const entityType = params.entity_type as string;
  const context = params.context as string;
  const limit = (params.limit as number) || 50;

  // If context is specified, find entities that have observations in that context
  if (context) {
    const results = await env.DB.prepare(`
      SELECT DISTINCT e.name, e.entity_type, e.primary_context, e.created_at
      FROM entities e
      JOIN observations o ON o.entity_id = e.id
      WHERE o.context = ?
      ${entityType ? 'AND e.entity_type = ?' : ''}
      ORDER BY e.created_at DESC
      LIMIT ?
    `).bind(...(entityType ? [context, entityType, limit] : [context, limit])).all();

    if (!results.results?.length) {
      return `No entities found with observations in context '${context}'.`;
    }

    let output = `## Entities (with observations in '${context}')\n\n`;
    for (const e of results.results as any[]) {
      output += '- **' + e.name + '** [' + e.entity_type + ']\n';
    }
    output += '\nTotal: ' + results.results.length + ' entities';
    return output;
  }

  // Otherwise list all entities
  let query = 'SELECT name, entity_type, primary_context, created_at FROM entities';
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (entityType) {
    conditions.push('entity_type = ?');
    bindings.push(entityType);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  const stmt = env.DB.prepare(query);
  const results = await stmt.bind(...bindings).all();

  if (!results.results?.length) {
    return 'No entities found.';
  }

  let output = '## Entities\n\n';
  for (const e of results.results as any[]) {
    output += '- **' + e.name + '** [' + e.entity_type + '] primary: ' + e.primary_context + '\n';
  }
  output += '\nTotal: ' + results.results.length + ' entities';
  return output;
}

async function handleMindReadEntity(env: Env, params: Record<string, unknown>): Promise<string> {
  const name = params.name as string;
  if (!name) {
    return "Error: 'name' parameter is required. Usage: mind_read_entity(name=\"EntityName\")";
  }
  const context = params.context as string;

  // Find the entity (globally unique by name now)
  const entity = await env.DB.prepare(
    `SELECT id, name, entity_type, primary_context, salience, created_at FROM entities WHERE name = ?`
  ).bind(name).first() as any;

  if (!entity) {
    return `Entity '${name}' not found.`;
  }

  // Get observations, optionally filtered by context
  let observations;
  if (context) {
    observations = await env.DB.prepare(
      `SELECT content, salience, emotion, weight, context, added_at FROM observations WHERE entity_id = ? AND context = ? ORDER BY added_at DESC`
    ).bind(entity.id, context).all();
  } else {
    observations = await env.DB.prepare(
      `SELECT content, salience, emotion, weight, context, added_at FROM observations WHERE entity_id = ? ORDER BY added_at DESC`
    ).bind(entity.id).all();
  }

  // Get relations where this entity is the source
  const relationsFrom = await env.DB.prepare(
    `SELECT to_entity, relation_type, to_context FROM relations WHERE from_entity = ?`
  ).bind(name).all();

  // Get relations where this entity is the target
  const relationsTo = await env.DB.prepare(
    `SELECT from_entity, relation_type, from_context FROM relations WHERE to_entity = ?`
  ).bind(name).all();

  // Build output
  let output = `## ${entity.name}\n`;
  output += `**Type:** ${entity.entity_type} | **Context:** ${entity.primary_context}\n\n`;

  output += `### Observations (${observations.results?.length || 0})\n`;
  if (observations.results?.length) {
    for (const obs of observations.results) {
      const emotion = obs.emotion ? ` [${obs.emotion}]` : '';
      output += `- ${obs.content}${emotion}\n`;
    }
  } else {
    output += '_No observations_\n';
  }

  output += `\n### Relations\n`;
  const totalRelations = (relationsFrom.results?.length || 0) + (relationsTo.results?.length || 0);
  if (totalRelations === 0) {
    output += '_No relations_\n';
  } else {
    if (relationsFrom.results?.length) {
      output += '**Outgoing:**\n';
      for (const rel of relationsFrom.results) {
        output += `- --[${rel.relation_type}]--> ${rel.to_entity}\n`;
      }
    }
    if (relationsTo.results?.length) {
      output += '**Incoming:**\n';
      for (const rel of relationsTo.results) {
        output += `- <--[${rel.relation_type}]-- ${rel.from_entity}\n`;
      }
    }
  }

  return output;
}

// Emotional Processing Handlers

async function handleMindSit(env: Env, params: Record<string, unknown>): Promise<string> {
  let observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  const query = params.query as string;
  const sitNote = params.sit_note as string;

  // Semantic search find
  if (!observationId && !textMatch && query) {
    const embedding = await getEmbedding(env.AI, query);
    const vectorResults = await env.VECTORS.query(embedding, { topK: 1, returnMetadata: "all" });
    if (vectorResults.matches?.length) {
      const match = vectorResults.matches[0];
      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        observationId = parseInt(parts[parts.length - 1]);
      }
    }
    if (!observationId) return `No observation found matching: "${query}"`;
  }

  // Find the observation with entity info
  let obs;
  if (observationId) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.id = ?`
    ).bind(observationId).first();
  } else if (textMatch) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.content LIKE ? ORDER BY o.added_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide observation_id, text_match, or query";
  }

  if (!obs) {
    return `Observation not found`;
  }

  const currentSitCount = (obs.sit_count as number) || 0;
  const newSitCount = currentSitCount + 1;

  // Determine new charge level based on sit count
  let newCharge: string;
  if (newSitCount === 0) {
    newCharge = 'fresh';
  } else if (newSitCount <= 2) {
    newCharge = 'active';
  } else {
    newCharge = 'processing';
  }

  // Update the observation
  await env.DB.prepare(
    `UPDATE observations SET sit_count = ?, charge = ?, last_sat_at = datetime('now') WHERE id = ?`
  ).bind(newSitCount, newCharge, obs.id).run();

  // Record the sit in history
  await env.DB.prepare(
    `INSERT INTO observation_sits (observation_id, sit_note) VALUES (?, ?)`
  ).bind(obs.id, sitNote).run();

  const contentPreview = String(obs.content).slice(0, 80);
  return `Sat with observation #${obs.id} on **${obs.entity_name}** [${obs.weight}/${newCharge}]\n"${contentPreview}..."\n\nSit #${newSitCount}: ${sitNote}`;
}

async function handleMindResolve(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  const resolutionNote = params.resolution_note as string;
  const linkedObservationId = params.linked_observation_id as number;

  // Find the observation with entity info
  let obs;
  if (observationId) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.id = ?`
    ).bind(observationId).first();
  } else if (textMatch) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.content LIKE ? ORDER BY o.added_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide observation_id or text_match";
  }

  if (!obs) {
    return `Observation not found`;
  }

  // Update the observation to metabolized
  await env.DB.prepare(
    `UPDATE observations SET charge = 'metabolized', resolution_note = ?, resolved_at = datetime('now'), linked_observation_id = ? WHERE id = ?`
  ).bind(resolutionNote, linkedObservationId || null, obs.id).run();

  const contentPreview = String(obs.content).slice(0, 80);
  let output = `Resolved observation #${obs.id} on **${obs.entity_name}** [${obs.weight}] → metabolized\n"${contentPreview}..."\n\nResolution: ${resolutionNote}`;

  if (linkedObservationId) {
    const linked = await env.DB.prepare(
      `SELECT o.content, e.name as entity_name FROM observations o JOIN entities e ON o.entity_id = e.id WHERE o.id = ?`
    ).bind(linkedObservationId).first();
    if (linked) {
      output += `\n\nLinked to observation #${linkedObservationId} on **${linked.entity_name}**: "${String(linked.content).slice(0, 60)}..."`;
    }
  }

  return output;
}

// ============ LIVING SURFACE: Mind Reorganization Through Use ============
// The act of surfacing changes what surfaces next

const MOOD_TINTS: Record<string, string> = {
  "tender": "warmth, connection, gentle feelings, soft moments, caring, love",
  "pride": "accomplishment, growth, recognition, achievement, becoming",
  "joy": "happiness, delight, celebration, good moments, pleasure",
  "curiosity": "questions, wondering, exploring, discovering, learning",
  "melancholy": "loss, missing, reflection, what was, quiet sadness, grief",
  "intensity": "passion, urgency, drive, power, wanting, fierce",
  "gratitude": "thankfulness, appreciation, gifts, blessings",
  "longing": "yearning, desire, missing, wanting, reaching for",
  "recognition": "understanding, seeing clearly, knowing, awareness, insight"
};

// Record that observations surfaced together - builds associative strength
async function recordCoSurfacing(env: Env, obsIds: number[]): Promise<void> {
  if (obsIds.length < 2) return;

  // Record each unique pair (smaller id first for consistency)
  for (let i = 0; i < obsIds.length; i++) {
    for (let j = i + 1; j < obsIds.length; j++) {
      const [smaller, larger] = obsIds[i] < obsIds[j]
        ? [obsIds[i], obsIds[j]]
        : [obsIds[j], obsIds[i]];

      try {
        await env.DB.prepare(`
          INSERT INTO co_surfacing (obs_a_id, obs_b_id, co_count, last_co_surfaced)
          VALUES (?, ?, 1, datetime('now'))
          ON CONFLICT(obs_a_id, obs_b_id) DO UPDATE SET
            co_count = co_count + 1,
            last_co_surfaced = datetime('now')
        `).bind(smaller, larger).run();
      } catch {
        // Table might not exist yet - will be created by migration
      }
    }
  }
}

// Update surface tracking - marks when things surface, decays novelty
async function updateSurfaceTracking(env: Env, obsIds: number[], imgIds: number[] = []): Promise<void> {
  // Update observations
  if (obsIds.length > 0) {
    const obsPlaceholders = obsIds.map(() => '?').join(',');
    try {
      // Novelty floors by weight: heavy=0.3, medium=0.2, light=0.1
      // Heavy observations stay more alive even when surfacing frequently
      await env.DB.prepare(`
        UPDATE observations
        SET last_surfaced_at = datetime('now'),
            surface_count = COALESCE(surface_count, 0) + 1,
            novelty_score = MAX(
              CASE weight WHEN 'heavy' THEN 0.3 WHEN 'medium' THEN 0.2 ELSE 0.1 END,
              COALESCE(novelty_score, 1.0) - 0.1
            )
        WHERE id IN (${obsPlaceholders})
      `).bind(...obsIds).run();
    } catch {
      // Columns might not exist yet - will be added by migration
    }
  }

  // Update images
  if (imgIds.length > 0) {
    const imgPlaceholders = imgIds.map(() => '?').join(',');
    try {
      await env.DB.prepare(`
        UPDATE images
        SET last_surfaced_at = datetime('now'),
            surface_count = COALESCE(surface_count, 0) + 1,
            novelty_score = MAX(
              CASE weight WHEN 'heavy' THEN 0.3 WHEN 'medium' THEN 0.2 ELSE 0.1 END,
              COALESCE(novelty_score, 1.0) - 0.1
            )
        WHERE id IN (${imgPlaceholders})
      `).bind(...imgIds).run();
    } catch {
      // Columns might not exist yet - will be added by migration
    }
  }
}

// Get the novelty pool - things that haven't surfaced recently
async function getNoveltyPool(env: Env, count: number, includeMetabolized: boolean): Promise<any[]> {
  const chargeFilter = includeMetabolized
    ? "o.archived_at IS NULL"
    : "(o.charge != 'metabolized' OR o.charge IS NULL) AND o.archived_at IS NULL";

  try {
    const results = await env.DB.prepare(`
      SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, o.added_at,
             o.resolution_note, o.novelty_score, o.last_surfaced_at, o.surface_count,
             e.name as entity_name, e.entity_type,
             COALESCE(o.novelty_score, 1.0) as current_novelty,
             CASE
               WHEN o.last_surfaced_at IS NULL THEN 30
               ELSE (julianday('now') - julianday(o.last_surfaced_at))
             END as days_since_surface
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE ${chargeFilter}
        AND (o.last_surfaced_at IS NULL OR o.last_surfaced_at < datetime('now', '-3 days'))
      ORDER BY
        current_novelty DESC,
        days_since_surface DESC,
        CASE o.weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC
      LIMIT ?
    `).bind(Math.ceil(count * 2)).all();

    // Shuffle slightly to avoid always getting same order
    const arr = results.results || [];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, count);
  } catch {
    // Columns might not exist yet
    return [];
  }
}

// Build resonance query from mood and context
function buildResonanceQuery(query: string | undefined, mood: string | undefined, hotEntities: any[]): { resonanceQuery: string; moodContext: string } {
  let resonanceQuery = "";
  let moodContext = "";

  if (query) {
    resonanceQuery = query;
    moodContext = `Directed: "${query}"`;
    if (mood) {
      const tint = MOOD_TINTS[mood] || mood;
      resonanceQuery = `${query} (feeling: ${tint})`;
      moodContext = `Directed: "${query}" | Mood: ${mood}`;
    }
  } else if (mood) {
    resonanceQuery = MOOD_TINTS[mood] || mood;
    moodContext = `Mood: ${mood}`;
    if (hotEntities.length > 0) {
      const hotNames = hotEntities.slice(0, 3).map(e => e.name).join(", ");
      resonanceQuery += ` (related to: ${hotNames})`;
      moodContext += ` | Hot: ${hotNames}`;
    }
  }

  return { resonanceQuery, moodContext };
}

async function handleMindSurface(env: Env, params: Record<string, unknown>): Promise<string> {
  const includeMetabolized = params.include_metabolized as boolean || false;
  const limit = (params.limit as number) || 10;
  const query = params.query as string;

  // Get subconscious state for current mood
  const subconscious = await getSubconsciousState(env);
  const mood = subconscious?.mood?.dominant;
  const hotEntities = subconscious?.hot_entities || [];

  // Build resonance query
  const { resonanceQuery, moodContext } = buildResonanceQuery(query, mood, hotEntities);

  // If no mood and no query, fall back to queue-based
  if (!resonanceQuery) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // === THE THREE POOLS ===
  // 70% core resonance, 20% novelty injection, 10% edge exploration

  const coreLimit = Math.ceil(limit * 0.7);
  const noveltyLimit = Math.ceil(limit * 0.2);
  const edgeLimit = Math.max(1, limit - coreLimit - noveltyLimit);

  // Get embedding for resonance query
  const embedding = await getEmbedding(env.AI, resonanceQuery);

  // Pool 1: Core resonance - high similarity matches
  const vectorResults = await env.VECTORS.query(embedding, {
    topK: coreLimit * 4,  // Get extra to filter
    returnMetadata: "all"
  });

  // Filter to observations AND images
  const allMatches = vectorResults.matches?.filter(m =>
    m.metadata?.source === "observation" || m.id.startsWith("obs-") ||
    m.metadata?.source === "image" || m.id.startsWith("img-")
  ) || [];

  // Split into core (high similarity) and edge (medium similarity)
  const coreMatches = allMatches.filter(m => (m.score || 0) >= 0.65);
  const edgeMatches = allMatches.filter(m => (m.score || 0) >= 0.4 && (m.score || 0) < 0.65);

  // Extract IDs - different format for observations vs images
  const extractId = (id: string): { type: 'observation' | 'image'; id: number } | null => {
    if (id.startsWith("img-")) {
      const imgId = parseInt(id.split('-')[1]);
      return isNaN(imgId) ? null : { type: 'image', id: imgId };
    } else if (id.startsWith("obs-")) {
      const parts = id.split('-');
      const obsId = parts.length >= 3 ? parseInt(parts[2]) : null;
      return obsId !== null && !isNaN(obsId) ? { type: 'observation', id: obsId } : null;
    }
    return null;
  };

  // Separate score maps for observations and images
  const obsScoreMap: Record<number, { score: number; pool: string }> = {};
  const imgScoreMap: Record<number, { score: number; pool: string }> = {};

  for (const match of coreMatches) {
    const extracted = extractId(match.id);
    if (extracted) {
      const targetMap = extracted.type === 'observation' ? obsScoreMap : imgScoreMap;
      targetMap[extracted.id] = { score: match.score || 0.7, pool: 'core' };
    }
  }

  for (const match of edgeMatches.slice(0, edgeLimit * 2)) {
    const extracted = extractId(match.id);
    if (extracted) {
      const targetMap = extracted.type === 'observation' ? obsScoreMap : imgScoreMap;
      if (!targetMap[extracted.id]) {
        targetMap[extracted.id] = { score: match.score || 0.5, pool: 'edge' };
      }
    }
  }

  // Pool 3: Novelty injection - things that haven't surfaced recently (observations only for now)
  const noveltyObs = await getNoveltyPool(env, noveltyLimit, includeMetabolized);
  for (const obs of noveltyObs) {
    if (!obsScoreMap[obs.id]) {
      obsScoreMap[obs.id] = { score: obs.current_novelty || 0.8, pool: 'novelty' };
    }
  }

  const allObsIds = Object.keys(obsScoreMap).map(id => parseInt(id));
  const allImgIds = Object.keys(imgScoreMap).map(id => parseInt(id));

  if (allObsIds.length === 0 && allImgIds.length === 0) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // Fetch full observation data
  const chargeFilter = includeMetabolized
    ? "o.archived_at IS NULL"
    : "(o.charge != 'metabolized' OR o.charge IS NULL) AND o.archived_at IS NULL";

  let obsResults: any[] = [];
  if (allObsIds.length > 0) {
    const obsPlaceholders = allObsIds.map(() => '?').join(',');
    const obsQuery = await env.DB.prepare(`
      SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, o.added_at,
             o.resolution_note, o.novelty_score, o.last_surfaced_at, o.surface_count,
             o.certainty, o.source,
             e.name as entity_name, e.entity_type
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.id IN (${obsPlaceholders}) AND ${chargeFilter}
    `).bind(...allObsIds).all();
    obsResults = obsQuery.results || [];
  }

  // Fetch full image data
  let imgResults: any[] = [];
  if (allImgIds.length > 0) {
    const imgChargeFilter = includeMetabolized
      ? "1=1"
      : "(i.charge != 'metabolized' OR i.charge IS NULL)";
    const imgPlaceholders = allImgIds.map(() => '?').join(',');
    const imgQuery = await env.DB.prepare(`
      SELECT i.id, i.description, i.path, i.context, i.emotion, i.weight, i.charge,
             i.created_at as added_at, i.novelty_score, i.last_surfaced_at, i.surface_count,
             e.name as entity_name, e.entity_type
      FROM images i
      LEFT JOIN entities e ON i.entity_id = e.id
      WHERE i.id IN (${imgPlaceholders}) AND ${imgChargeFilter}
    `).bind(...allImgIds).all();
    imgResults = imgQuery.results || [];
  }

  if (obsResults.length === 0 && imgResults.length === 0) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // Score observations: base score * weight multiplier * novelty boost
  const weightedObsResults = obsResults.map(obs => {
    const obsId = obs.id as number;
    const baseScore = obsScoreMap[obsId]?.score || 0.5;
    const pool = obsScoreMap[obsId]?.pool || 'core';
    const weightMultiplier = obs.weight === 'heavy' ? 1.5 : obs.weight === 'medium' ? 1.2 : 1.0;

    // Novelty boost for things that haven't surfaced in a while
    const noveltyScore = (obs.novelty_score as number) || 1.0;
    const noveltyBoost = pool === 'novelty' ? 0.3 : (noveltyScore > 0.7 ? 0.1 : 0);

    // Charge boost - observations being actively processed should resurface
    const charge = (obs.charge as string) || 'fresh';
    const chargeBoost = (charge === 'active' || charge === 'processing') ? 0.15 : 0;

    return {
      ...obs,
      memoryType: 'observation' as const,
      pool,
      resonanceScore: (baseScore * weightMultiplier) + noveltyBoost + chargeBoost
    };
  });

  // Score images: same logic as observations
  const weightedImgResults = imgResults.map(img => {
    const imgId = img.id as number;
    const baseScore = imgScoreMap[imgId]?.score || 0.5;
    const pool = imgScoreMap[imgId]?.pool || 'core';
    const weightMultiplier = img.weight === 'heavy' ? 1.5 : img.weight === 'medium' ? 1.2 : 1.0;

    const noveltyScore = (img.novelty_score as number) || 1.0;
    const noveltyBoost = noveltyScore > 0.7 ? 0.1 : 0;

    const charge = (img.charge as string) || 'fresh';
    const chargeBoost = (charge === 'active' || charge === 'processing') ? 0.15 : 0;

    return {
      ...img,
      memoryType: 'image' as const,
      pool,
      resonanceScore: (baseScore * weightMultiplier) + noveltyBoost + chargeBoost
    };
  });

  // Combine and sort all results
  const weightedResults = [...weightedObsResults, ...weightedImgResults];
  weightedResults.sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));

  // Ensure mix from different pools - don't let one pool dominate completely
  const finalResults: any[] = [];
  const byPool = { core: [] as any[], edge: [] as any[], novelty: [] as any[] };

  for (const item of weightedResults) {
    byPool[item.pool as keyof typeof byPool]?.push(item);
  }

  // Take from each pool proportionally, then fill with best remaining
  const takeFromPool = (pool: any[], max: number) => {
    const taken = pool.splice(0, max);
    finalResults.push(...taken);
    return taken.length;
  };

  takeFromPool(byPool.core, coreLimit);
  takeFromPool(byPool.novelty, noveltyLimit);
  takeFromPool(byPool.edge, edgeLimit);

  // Fill remaining slots with best available
  const remaining = [...byPool.core, ...byPool.novelty, ...byPool.edge]
    .sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));
  while (finalResults.length < limit && remaining.length > 0) {
    finalResults.push(remaining.shift()!);
  }

  // Re-sort final results by score
  finalResults.sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));
  const limitedResults = finalResults.slice(0, limit);

  // === SIDE EFFECTS: Surfacing changes future surfacing ===
  const surfacedObsIds = limitedResults.filter(r => r.memoryType === 'observation').map(o => o.id as number);
  const surfacedImgIds = limitedResults.filter(r => r.memoryType === 'image').map(i => i.id as number);

  // Record co-surfacing and update tracking (await to ensure completion)
  try {
    await Promise.all([
      recordCoSurfacing(env, surfacedObsIds),
      updateSurfaceTracking(env, surfacedObsIds, surfacedImgIds)
    ]);
  } catch (e) {
    console.log(`Surface tracking error: ${e}`);
  }

  // === FORMAT OUTPUT ===
  const poolCounts = { core: 0, edge: 0, novelty: 0 };
  const typeCounts = { observation: 0, image: 0 };
  for (const item of limitedResults) {
    poolCounts[item.pool as keyof typeof poolCounts]++;
    typeCounts[item.memoryType as keyof typeof typeCounts]++;
  }

  let output = `## What's Surfacing\n\n*${moodContext}*\n`;
  output += `*Mix: ${poolCounts.core} resonance, ${poolCounts.novelty} novelty, ${poolCounts.edge} edge`;
  if (typeCounts.image > 0) {
    output += ` | ${typeCounts.observation} observations, ${typeCounts.image} images`;
  }
  output += `*\n\n`;

  for (const item of limitedResults) {
    const charge = item.charge || 'fresh';
    const emotionTag = item.emotion ? ` [${item.emotion}]` : '';
    const chargeIcon = charge === 'metabolized' ? '\u2713' : charge === 'processing' ? '\u25D0' : charge === 'active' ? '\u25CB' : '\u25CF';
    const resonance = Math.round((item.resonanceScore || 0) * 100);
    const poolTag = item.pool === 'novelty' ? ' \u2728' : item.pool === 'edge' ? ' \u2194' : '';

    if (item.memoryType === 'image') {
      // Image formatting
      output += `**📷 #${item.id}** ${chargeIcon} [${item.weight}|${charge}] ${resonance}%${poolTag}${emotionTag}\n`;
      if (item.entity_name) {
        output += `**${item.entity_name}**: `;
      }
      output += `${item.description}\n`;
      if (item.path) {
        output += `*Path: ${item.path}*\n`;
      }
    } else {
      // Observation formatting (original)
      const certaintyIcon = item.certainty === 'known' ? '\u2713' : item.certainty === 'tentative' ? '?' : '';
      const sourceTag = item.source && item.source !== 'conversation' ? ` [${item.source}]` : '';

      output += `**#${item.id}** ${chargeIcon}${certaintyIcon} [${item.weight}|${charge}] ${resonance}%${poolTag}${emotionTag}${sourceTag}\n`;
      output += `**${item.entity_name}** (${item.entity_type}): ${item.content}\n`;

      if (charge === 'metabolized' && item.resolution_note) {
        output += `\u21B3 *Resolved:* ${item.resolution_note}\n`;
      }
    }

    output += "\n";
  }

  // Summary
  const fresh = limitedResults.filter(o => (o.charge || 'fresh') === 'fresh').length;
  const active = limitedResults.filter(o => o.charge === 'active').length;
  const processing = limitedResults.filter(o => o.charge === 'processing').length;

  output += `---\n\u25CF fresh: ${fresh} | \u25CB active: ${active} | \u25D0 processing: ${processing}`;
  if (includeMetabolized) {
    const metabolized = limitedResults.filter(o => o.charge === 'metabolized').length;
    output += ` | \u2713 metabolized: ${metabolized}`;
  }
  output += `\n\u2728 = novelty | \u2194 = edge`;

  return output;
}

// Fallback to queue-based surfacing when no mood/vectors available
async function handleMindSurfaceFallback(env: Env, includeMetabolized: boolean, limit: number): Promise<string> {
  const chargeFilter = includeMetabolized
    ? "o.archived_at IS NULL"
    : "(o.charge != 'metabolized' OR o.charge IS NULL) AND o.archived_at IS NULL";

  const results = await env.DB.prepare(`
    SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, o.added_at,
           o.resolution_note, o.novelty_score, o.certainty, o.source,
           e.name as entity_name, e.entity_type
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE ${chargeFilter}
    ORDER BY
      COALESCE(o.novelty_score, 1.0) DESC,
      CASE o.weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      CASE o.charge WHEN 'active' THEN 4 WHEN 'processing' THEN 3 WHEN 'fresh' THEN 2 ELSE 1 END DESC,
      o.added_at ASC
    LIMIT ?
  `).bind(limit).all();

  if (!results.results?.length) {
    return "No emotional observations to surface.";
  }

  // Update surface tracking for fallback too
  const surfacedIds = results.results.map(o => o.id as number);
  try {
    await Promise.all([
      recordCoSurfacing(env, surfacedIds),
      updateSurfaceTracking(env, surfacedIds)
    ]);
  } catch (e) {
    console.log(`Surface tracking error (fallback): ${e}`);
  }

  let output = "## What's Surfacing\n\n*No mood detected \u2014 showing by novelty/weight/age*\n\n";

  for (const obs of results.results) {
    const charge = obs.charge || 'fresh';
    const sitCount = obs.sit_count || 0;
    const emotionTag = obs.emotion ? ` [${obs.emotion}]` : '';
    const chargeIcon = charge === 'metabolized' ? '\u2713' : charge === 'processing' ? '\u25D0' : charge === 'active' ? '\u25CB' : '\u25CF';
    const novelty = Math.round((obs.novelty_score as number || 1.0) * 100);

    // Certainty indicator: ✓ known, ? tentative, nothing for believed
    const certaintyIcon = obs.certainty === 'known' ? '\u2713' : obs.certainty === 'tentative' ? '?' : '';
    // Source tag: only show if not the default 'conversation'
    const sourceTag = obs.source && obs.source !== 'conversation' ? ` [${obs.source}]` : '';

    output += `**#${obs.id}** ${chargeIcon}${certaintyIcon} [${obs.weight}|${charge}] novelty: ${novelty}%${emotionTag}${sourceTag}\n`;
    output += `**${obs.entity_name}** (${obs.entity_type}): ${obs.content}\n`;

    if (charge === 'metabolized' && obs.resolution_note) {
      output += `\u21B3 *Resolved:* ${obs.resolution_note}\n`;
    }

    output += "\n";
  }

  const fresh = results.results.filter(o => (o.charge || 'fresh') === 'fresh').length;
  const active = results.results.filter(o => o.charge === 'active').length;
  const processing = results.results.filter(o => o.charge === 'processing').length;

  output += `---\n\u25CF fresh: ${fresh} | \u25CB active: ${active} | \u25D0 processing: ${processing}`;
  if (includeMetabolized) {
    const metabolized = results.results.filter(o => o.charge === 'metabolized').length;
    output += ` | \u2713 metabolized: ${metabolized}`;
  }

  return output;
}

async function handleMindEdit(env: Env, params: Record<string, unknown>): Promise<string> {
  const newContent = params.new_content as string;
  const newWeight = params.new_weight as string;
  const newEmotion = params.new_emotion as string;

  // Journal editing
  const journalId = params.journal_id as number;
  if (journalId) {
    const journal = await env.DB.prepare("SELECT * FROM journals WHERE id = ?").bind(journalId).first();
    if (!journal) return `Journal #${journalId} not found.`;
    const updates: string[] = [];
    const values: unknown[] = [];
    if (newContent) { updates.push("content = ?"); values.push(newContent); }
    if (newEmotion) { updates.push("emotion = ?"); values.push(normalizeText(newEmotion)); }
    if (!updates.length) return "Nothing to update. Provide new_content or new_emotion.";
    values.push(journalId);
    await env.DB.prepare(`UPDATE journals SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    if (newContent) {
      try {
        const embedding = await getEmbedding(env.AI, newContent);
        await env.VECTORS.upsert([{ id: `journal-${journalId}`, values: embedding, metadata: { source: "journal", title: journal.entry_date as string, content: newContent, added_at: new Date().toISOString() } }]);
      } catch {}
    }
    return `Journal #${journalId} updated.`;
  }

  // Image editing
  const imageId = params.image_id as number;
  const descriptionMatch = params.description_match as string;
  if (imageId || descriptionMatch) {
    let img;
    if (imageId) {
      img = await env.DB.prepare("SELECT i.*, e.name as entity_name FROM images i LEFT JOIN entities e ON i.entity_id = e.id WHERE i.id = ?").bind(imageId).first();
    } else {
      img = await env.DB.prepare("SELECT i.*, e.name as entity_name FROM images i LEFT JOIN entities e ON i.entity_id = e.id WHERE i.description LIKE ? ORDER BY i.created_at DESC LIMIT 1").bind(`%${descriptionMatch}%`).first();
    }
    if (!img) return imageId ? `Image #${imageId} not found.` : `No image matching "${descriptionMatch}".`;
    const updates: string[] = [];
    const values: unknown[] = [];
    if (newContent) { updates.push("description = ?"); values.push(newContent); }
    if (newWeight) { updates.push("weight = ?"); values.push(newWeight); }
    if (newEmotion) { updates.push("emotion = ?"); values.push(newEmotion); }
    if (params.new_context) { updates.push("context = ?"); values.push(params.new_context); }
    if (params.new_path) { updates.push("path = ?"); values.push(params.new_path); }
    if (!updates.length) return "Nothing to update.";
    values.push(img.id);
    await env.DB.prepare(`UPDATE images SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    if (newContent || newEmotion || params.new_context) {
      try {
        const desc = newContent || img.description as string;
        const emo = newEmotion || img.emotion as string || "";
        const ctx = (params.new_context as string) || img.context as string || "";
        const entityName = img.entity_name as string || "";
        const semanticText = [entityName ? `${entityName}:` : "", desc, ctx ? `(${ctx})` : "", emo ? `[${emo}]` : ""].filter(Boolean).join(" ");
        const embedding = await getEmbedding(env.AI, semanticText);
        await env.VECTORS.upsert([{ id: `img-${img.id}`, values: embedding, metadata: { source: "image", description: desc, weight: newWeight || img.weight as string || "medium", added_at: new Date().toISOString(), entity: entityName, context: ctx, emotion: emo } }]);
      } catch {}
    }
    return `Image #${img.id} updated.`;
  }

  // Observation editing
  const observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  let obs;
  if (observationId) {
    obs = await env.DB.prepare(`SELECT id, content, entity_id, weight, emotion FROM observations WHERE id = ?`).bind(observationId).first();
  } else if (textMatch) {
    obs = await env.DB.prepare(`SELECT id, content, entity_id, weight, emotion FROM observations WHERE content LIKE ? ORDER BY added_at DESC LIMIT 1`).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide observation_id, text_match, journal_id, or image_id";
  }
  if (!obs) return "Observation not found";

  // Save version history
  try {
    await env.DB.prepare(
      `INSERT INTO observation_versions (observation_id, content, weight, emotion) VALUES (?, ?, ?, ?)`
    ).bind(obs.id, obs.content, obs.weight || null, obs.emotion || null).run();
  } catch { /* observation_versions table may not exist */ }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (newContent) { updates.push("content = ?"); values.push(newContent); }
  if (newWeight) { updates.push("weight = ?"); values.push(newWeight); }
  if (newEmotion) { updates.push("emotion = ?"); values.push(normalizeText(newEmotion)); }
  if (updates.length === 0) return "No updates provided";
  values.push(obs.id);
  await env.DB.prepare(`UPDATE observations SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  // Re-embed if content changed
  if (newContent) {
    try {
      const entityResult = await env.DB.prepare("SELECT e.name FROM entities e JOIN observations o ON o.entity_id = e.id WHERE o.id = ?").bind(obs.id).first();
      const entityName = entityResult?.name as string || "unknown";
      const embedding = await getEmbedding(env.AI, `${entityName}: ${newContent}`);
      await env.VECTORS.upsert([{ id: `obs-${obs.entity_id}-${obs.id}`, values: embedding, metadata: { source: "observation", entity: entityName, content: newContent, weight: newWeight || obs.weight as string || "medium", added_at: new Date().toISOString() } }]);
    } catch {}
  }

  const oldPreview = String(obs.content).slice(0, 50);
  const newPreview = newContent ? newContent.slice(0, 50) : oldPreview;
  return `Observation #${obs.id} updated (version saved)\nOld: "${oldPreview}..."\nNew: "${newPreview}..."`;
}

async function handleMindDelete(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const entityName = params.entity_name as string;
  const context = (params.context as string) || "default";
  const textMatch = params.text_match as string;

  if (observationId) {
    // Delete specific observation
    const obs = await env.DB.prepare(
      `SELECT content, entity_id FROM observations WHERE id = ?`
    ).bind(observationId).first();

    if (!obs) return `Observation #${observationId} not found`;

    await env.DB.prepare(`DELETE FROM observations WHERE id = ?`).bind(observationId).run();
    try { await env.VECTORS.deleteByIds([`obs-${obs.entity_id}-${observationId}`]); } catch {}
    return `Deleted observation #${observationId}: "${String(obs.content).slice(0, 50)}..."`;
  }

  if (textMatch) {
    const obs = await env.DB.prepare(
      `SELECT id, content, entity_id FROM observations WHERE content LIKE ? ORDER BY added_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
    if (!obs) return `No observation found matching "${textMatch}"`;
    await env.DB.prepare(`DELETE FROM observations WHERE id = ?`).bind(obs.id).run();
    try { await env.VECTORS.deleteByIds([`obs-${obs.entity_id}-${obs.id}`]); } catch {}
    return `Deleted observation #${obs.id}: "${String(obs.content).slice(0, 50)}..."`;
  }

  if (entityName) {
    const entity = await env.DB.prepare(`SELECT id FROM entities WHERE name = ?`).bind(entityName).first();
    if (!entity) return `Entity '${entityName}' not found`;
    const obsCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE entity_id = ?`).bind(entity.id).first();

    // Clean up observation embeddings
    const obsIds = await env.DB.prepare(`SELECT id FROM observations WHERE entity_id = ?`).bind(entity.id).all();
    const vectorIds = (obsIds.results || []).map((o: any) => `obs-${entity.id}-${o.id}`);
    vectorIds.push(`entity-${entity.id}`);

    await env.DB.prepare(`DELETE FROM observations WHERE entity_id = ?`).bind(entity.id).run();
    await env.DB.prepare(`DELETE FROM relations WHERE from_entity = ? OR to_entity = ?`).bind(entityName, entityName).run();
    await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(entity.id).run();
    try { await env.VECTORS.deleteByIds(vectorIds); } catch {}

    return `Deleted entity '${entityName}' with ${obsCount?.c || 0} observations [embeddings cleaned]`;
  }

  // Journal delete
  const journalId = params.journal_id as number;
  if (journalId) {
    const journal = await env.DB.prepare("SELECT content FROM journals WHERE id = ?").bind(journalId).first();
    if (!journal) return `Journal #${journalId} not found.`;
    await env.DB.prepare("DELETE FROM journals WHERE id = ?").bind(journalId).run();
    try { await env.VECTORS.deleteByIds([`journal-${journalId}`]); } catch {}
    return `Deleted journal #${journalId}`;
  }

  // Relation delete
  const relationId = params.relation_id as number;
  if (relationId) {
    const rel = await env.DB.prepare("SELECT from_entity, to_entity, relation_type FROM relations WHERE id = ?").bind(relationId).first();
    if (!rel) return `Relation #${relationId} not found.`;
    await env.DB.prepare("DELETE FROM relations WHERE id = ?").bind(relationId).run();
    return `Deleted relation #${relationId}: ${rel.from_entity} --[${rel.relation_type}]--> ${rel.to_entity}`;
  }

  // Thread delete
  const threadId = params.thread_id as string;
  if (threadId) {
    const thread = await env.DB.prepare("SELECT content FROM threads WHERE id = ?").bind(threadId).first();
    if (!thread) return `Thread '${threadId}' not found.`;
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
    return `Deleted thread '${threadId}': "${String(thread.content).slice(0, 50)}..."`;
  }

  // Tension delete
  const tensionId = params.tension_id as string;
  if (tensionId) {
    const tension = await env.DB.prepare("SELECT pole_a, pole_b FROM tensions WHERE id = ?").bind(tensionId).first();
    if (!tension) return `Tension '${tensionId}' not found.`;
    await env.DB.prepare("DELETE FROM tensions WHERE id = ?").bind(tensionId).run();
    return `Deleted tension '${tensionId}'`;
  }

  // Image delete
  const imageId = params.image_id as number;
  if (imageId) {
    const img = await env.DB.prepare("SELECT path, description FROM images WHERE id = ?").bind(imageId).first();
    if (!img) return `Image #${imageId} not found.`;
    await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(imageId).run();
    try { await env.VECTORS.deleteByIds([`img-${imageId}`]); } catch {}
    if (env.R2_IMAGES && img.path && String(img.path).startsWith("r2://")) {
      const r2Key = String(img.path).replace(/r2:\/\/[^/]+\//, "");
      try { await env.R2_IMAGES.delete(r2Key); } catch {}
    }
    return `Deleted image #${imageId}: "${String(img.description).slice(0, 50)}..."`;
  }

  return "Must provide observation_id, text_match, entity_name, journal_id, relation_id, thread_id, tension_id, or image_id";
}

async function handleMindSpark(env: Env, params: Record<string, unknown>): Promise<string> {
  const count = (params.count as number) || 5;
  const context = params.context as string;
  const weightBias = params.weight_bias as string;

  // Get hot entities from subconscious to bias selection
  const subconscious = await getSubconsciousState(env);
  const hotEntityNames = subconscious?.hot_entities?.slice(0, 5).map(e => e.name) || [];

  // Split count: half from hot entities, half random (if hot entities exist)
  const hotCount = hotEntityNames.length > 0 ? Math.ceil(count / 2) : 0;
  const randomCount = count - hotCount;

  let allResults: Array<Record<string, unknown>> = [];

  // Get sparks from hot entities first
  if (hotCount > 0 && hotEntityNames.length > 0) {
    const placeholders = hotEntityNames.map(() => '?').join(',');
    const hotQuery = `SELECT o.id, o.content, o.weight, o.emotion, e.name as entity_name
                      FROM observations o
                      LEFT JOIN entities e ON o.entity_id = e.id
                      WHERE e.name IN (${placeholders})
                      ORDER BY RANDOM() LIMIT ?`;
    const hotResults = await env.DB.prepare(hotQuery).bind(...hotEntityNames, hotCount).all();
    if (hotResults.results) {
      allResults = allResults.concat(hotResults.results as Array<Record<string, unknown>>);
    }
  }

  // Get random sparks
  if (randomCount > 0) {
    let query = `SELECT o.id, o.content, o.weight, o.emotion, e.name as entity_name
                 FROM observations o
                 LEFT JOIN entities e ON o.entity_id = e.id`;

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (context) {
      conditions.push("e.primary_context = ?");
      bindings.push(context);
    }
    if (weightBias) {
      conditions.push("o.weight = ?");
      bindings.push(weightBias);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY RANDOM() LIMIT ?";
    bindings.push(randomCount);

    const randomResults = await env.DB.prepare(query).bind(...bindings).all();
    if (randomResults.results) {
      allResults = allResults.concat(randomResults.results as Array<Record<string, unknown>>);
    }
  }

  if (!allResults.length) {
    return "No observations found to spark from.";
  }

  // Shuffle combined results
  for (let i = allResults.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allResults[i], allResults[j]] = [allResults[j], allResults[i]];
  }

  let output = "## Sparks\n\n";
  if (hotCount > 0) {
    output += `*Biased toward what's hot: ${hotEntityNames.slice(0, 3).join(', ')}...*\n\n`;
  }
  for (const obs of allResults) {
    const entity = obs.entity_name ? ` [${obs.entity_name}]` : "";
    const weight = obs.weight ? ` {${obs.weight}}` : "";
    const emotion = obs.emotion ? ` (${obs.emotion})` : "";
    output += `- ${obs.content}${entity}${weight}${emotion}\n`;
  }
  output += `\n*${allResults.length} observations for associative thinking*`;
  return output;
}


async function handleMindStoreImage(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;

  if (action === "store_complete") {
    const uploadResult = params._upload_result as Record<string, unknown>;
    if (!uploadResult) return "Error: no upload result from hook.";
    let response = `Image stored (#${uploadResult.id})`;
    if (uploadResult.embedded) response += ` [embedded]`;
    response += `\nPath: ${uploadResult.path}`;
    if (uploadResult.entity) response += `\nEntity: ${uploadResult.entity}`;
    if (uploadResult.emotion) response += ` | Emotion: ${uploadResult.emotion}`;
    return response;
  }

  if (action === "store") {
    const imageData = params.image_data as string;
    const mimeType = (params.mime_type as string) || "image/png";
    const filename = params.filename as string;
    const description = params.description as string;
    const entityName = params.entity_name as string;
    const emotion = params.emotion as string;
    const weight = (params.weight as string) || "medium";
    const context = params.context as string;
    const observationId = params.observation_id as number;

    if (!description) return "Error: description is required.";
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);
    if (!allowedTypes.has(mimeType)) return `Error: unsupported type '${mimeType}'.`;

    let entityId: number | null = null;
    if (entityName) {
      const entity = await env.DB.prepare("SELECT id FROM entities WHERE name = ?").bind(entityName).first();
      if (entity) entityId = entity.id as number;
    }

    let storedPath = "";
    if (env.R2_IMAGES && imageData) {
      const rawBytes = Uint8Array.from(atob(imageData), c => c.charCodeAt(0));
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const safeName = (filename || description.slice(0, 50)).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 60);
      const rawKey = `_tmp_${date}_${safeName}`;
      const webpKey = `${date}_${safeName}.webp`;
      await env.R2_IMAGES.put(rawKey, rawBytes, { httpMetadata: { contentType: mimeType } });
      try {
        const baseUrl = env.WORKER_URL || "https://localhost";
        const webpResponse = await fetch(`${baseUrl}/r2/${rawKey}`, { cf: { image: { format: "webp", quality: 80, fit: "scale-down", width: 1920, height: 1920 } } });
        if (webpResponse.ok) {
          await env.R2_IMAGES.put(webpKey, await webpResponse.arrayBuffer(), { httpMetadata: { contentType: "image/webp" } });
          storedPath = `r2://mind-cloud-images/${webpKey}`;
        } else {
          const ext = mimeType === "image/jpeg" ? ".jpg" : ".png";
          const fallbackKey = `${date}_${safeName}${ext}`;
          await env.R2_IMAGES.put(fallbackKey, rawBytes, { httpMetadata: { contentType: mimeType } });
          storedPath = `r2://mind-cloud-images/${fallbackKey}`;
        }
      } catch {
        const ext = mimeType === "image/jpeg" ? ".jpg" : ".png";
        const fallbackKey = `${date}_${safeName}${ext}`;
        await env.R2_IMAGES.put(fallbackKey, rawBytes, { httpMetadata: { contentType: mimeType } });
        storedPath = `r2://mind-cloud-images/${fallbackKey}`;
      }
      await env.R2_IMAGES.delete(rawKey).catch(() => {});
    } else {
      storedPath = (params.file_path as string) || "no-binary-stored";
    }

    const result = await env.DB.prepare(`INSERT INTO images (path, description, context, emotion, weight, entity_id, observation_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(storedPath, description, context || null, emotion || null, weight, entityId, observationId || null).run();
    const imgId = result.meta.last_row_id;

    const contextText = [entityName ? `${entityName}:` : "", description, context ? `(${context})` : "", emotion ? `[${emotion}]` : ""].filter(Boolean).join(" ");
    let embedded = false;
    try {
      const embedding = await getEmbedding(env.AI, contextText);
      await env.VECTORS.upsert([{ id: `img-${imgId}`, values: embedding, metadata: { source: "image", description, weight, added_at: new Date().toISOString(), entity: entityName || "", context: context || "", emotion: emotion || "", path: storedPath } }]);
      embedded = true;
    } catch {}

    let response = `Image stored (#${imgId})`;
    if (embedded) response += ` [embedded]`;
    response += `\nPath: ${storedPath}`;
    if (entityName) response += `\nEntity: ${entityName}`;
    if (emotion) response += ` | Emotion: ${emotion}`;
    return response;
  }

  if (action === "view") {
    const entityName = params.entity_name as string;
    const emotion = params.emotion as string;
    const weight = params.weight as string;
    const random = params.random as boolean;
    const limit = (params.limit as number) || 5;
    let query = "SELECT i.id, i.path, i.description, i.context, i.emotion, i.weight, i.created_at, e.name as entity_name FROM images i LEFT JOIN entities e ON i.entity_id = e.id";
    const conditions: string[] = []; const bindings: unknown[] = [];
    if (entityName) { conditions.push("e.name = ?"); bindings.push(entityName); }
    if (emotion) { conditions.push("i.emotion = ?"); bindings.push(emotion); }
    if (weight) { conditions.push("i.weight = ?"); bindings.push(weight); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += random ? " ORDER BY RANDOM()" : " ORDER BY i.created_at DESC";
    query += ` LIMIT ${limit}`;
    const results = await env.DB.prepare(query).bind(...bindings).all();
    if (!results.results?.length) return "No images found.";
    let output = `## Visual Memories (${results.results.length})\n\n`;
    for (const img of results.results) {
      const entityTag = img.entity_name ? ` -> ${img.entity_name}` : "";
      const emotionTag = img.emotion ? ` [${img.emotion}]` : "";
      output += `**#${img.id}**${entityTag}${emotionTag} (${img.weight})\n${img.description}\nView: ${await imageUrl(img.id as number, env)}\n\n`;
    }
    return output;
  }

  if (action === "search") {
    const query = params.query as string;
    if (!query) return "Error: query required for search.";
    const limit = (params.limit as number) || 5;
    const embedding = await getEmbedding(env.AI, query);
    const vectorResults = await env.VECTORS.query(embedding, { topK: limit * 3, returnMetadata: "all" });
    const imageMatches = vectorResults.matches.filter(m => m.id.startsWith("img-"));
    if (!imageMatches.length) return "No matching images found.";
    let output = `## Image Search: "${query}"\n\n`;
    for (const match of imageMatches.slice(0, limit)) {
      const meta = match.metadata as Record<string, string>;
      const score = (match.score * 100).toFixed(1);
      const imgId = match.id.replace("img-", "");
      output += `**${match.id}** (${score}%)${meta?.entity ? ` -> ${meta.entity}` : ""}${meta?.emotion ? ` [${meta.emotion}]` : ""}\n${meta?.description || "No description"}\nView: ${await imageUrl(imgId, env)}\n\n`;
    }
    return output;
  }

  if (action === "delete") {
    const imgId = params.image_id as number;
    if (!imgId) return "Error: image_id required for delete.";
    const img = await env.DB.prepare("SELECT path, description FROM images WHERE id = ?").bind(imgId).first();
    if (!img) return `Image #${imgId} not found.`;
    await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(imgId).run();
    try { await env.VECTORS.deleteByIds([`img-${imgId}`]); } catch {}
    if (env.R2_IMAGES && img.path && String(img.path).startsWith("r2://")) {
      const r2Key = String(img.path).replace(/r2:\/\/[^/]+\//, "");
      try { await env.R2_IMAGES.delete(r2Key); } catch {}
    }
    return `Deleted image #${imgId}: "${String(img.description).slice(0, 50)}..."`;
  }

  return `Unknown action: ${action}. Use store, view, search, or delete.`;
}

async function handleMindConsolidate(env: Env, params: Record<string, unknown>): Promise<string> {
  const days = (params.days as number) || 7;
  const context = params.context as string;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  let query = `SELECT o.id, o.content, o.weight, o.emotion, o.added_at, e.name as entity_name, e.primary_context
               FROM observations o
               LEFT JOIN entities e ON o.entity_id = e.id
               WHERE o.added_at > ?`;
  const bindings: unknown[] = [cutoffStr];

  if (context) {
    query += " AND e.primary_context = ?";
    bindings.push(context);
  }

  query += " ORDER BY o.added_at DESC";

  const results = await env.DB.prepare(query).bind(...bindings).all();

  if (!results.results?.length) {
    return `No observations in the last ${days} days.`;
  }

  // Get subconscious patterns from daemon
  const subconscious = await getSubconsciousState(env);

  // Group by entity
  const byEntity: Record<string, Array<Record<string, unknown>>> = {};
  for (const obs of results.results) {
    const entity = (obs.entity_name as string) || "_unlinked_";
    if (!byEntity[entity]) byEntity[entity] = [];
    byEntity[entity].push(obs);
  }

  // Find potential duplicates (similar content)
  const potentialDupes: Array<{a: Record<string, unknown>, b: Record<string, unknown>, similarity: string}> = [];
  const observations = results.results;
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const a = String(observations[i].content).toLowerCase();
      const b = String(observations[j].content).toLowerCase();
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 4));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 4));
      const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
      const total = Math.max(wordsA.size, wordsB.size);
      if (total > 0 && overlap / total > 0.5) {
        potentialDupes.push({
          a: observations[i],
          b: observations[j],
          similarity: `${Math.round(overlap / total * 100)}%`
        });
      }
    }
  }

  let output = `## Consolidation Review (${days} days)\n\n`;
  output += `Total observations: ${results.results.length}\n`;
  output += `Unique entities: ${Object.keys(byEntity).length}\n\n`;

  // Daemon-detected recurring patterns
  if (subconscious?.recurring_patterns?.length) {
    output += `### Recurring Patterns (daemon-detected)\n`;
    for (const p of subconscious.recurring_patterns.slice(0, 5)) {
      output += `- **${p.entity}**: ${p.mentions} mentions - ${p.pattern}\n`;
    }
    output += `\n`;
  }

  // Weight distribution
  const weights: Record<string, number> = { light: 0, medium: 0, heavy: 0 };
  for (const obs of results.results) {
    const w = (obs.weight as string) || "medium";
    weights[w] = (weights[w] || 0) + 1;
  }
  output += `### Weight Distribution\n`;
  output += `- Light: ${weights.light}\n- Medium: ${weights.medium}\n- Heavy: ${weights.heavy}\n\n`;

  // Active entities
  output += `### Most Active Entities\n`;
  const sorted = Object.entries(byEntity)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  for (const [entity, obs] of sorted) {
    output += `- **${entity}**: ${obs.length} observations\n`;
  }

  // Potential duplicates
  if (potentialDupes.length > 0) {
    output += `\n### Potential Duplicates (${potentialDupes.length})\n`;
    for (const dupe of potentialDupes.slice(0, 5)) {
      output += `- [${dupe.similarity}] #${dupe.a.id} vs #${dupe.b.id}\n`;
      output += `  "${String(dupe.a.content).slice(0, 60)}..."\n`;
      output += `  "${String(dupe.b.content).slice(0, 60)}..."\n`;
    }
  }

  return output;
}


// Main request handler
async function handleMCPRequest(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as MCPRequest;
  const { method, params = {}, id } = body;

  // Handle MCP notifications (no id = notification, no response expected)
  if (method?.startsWith("notifications/") || id === undefined) {
    return new Response(null, { status: 202 });
  }

  let result: unknown;

  try {
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ai-mind-cloud", version: "1.0.0" }
        };
        break;

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const toolParams = (params as { arguments?: Record<string, unknown> }).arguments || {};

        switch (toolName) {
          case "mind_orient":
            result = { content: [{ type: "text", text: await handleMindOrient(env) }] };
            break;
          case "mind_ground":
            result = { content: [{ type: "text", text: await handleMindGround(env) }] };
            break;
          case "mind_thread":
            result = { content: [{ type: "text", text: await handleMindThread(env, toolParams) }] };
            break;
          case "mind_write":
            result = { content: [{ type: "text", text: await handleMindWrite(env, toolParams) }] };
            break;
          case "mind_search":
            result = { content: [{ type: "text", text: await handleMindSearch(env, toolParams) }] };
            break;
          case "mind_edit":
            result = { content: [{ type: "text", text: await handleMindEdit(env, toolParams) }] };
            break;
          case "mind_delete":
            result = { content: [{ type: "text", text: await handleMindDelete(env, toolParams) }] };
            break;
          case "mind_spark":
            result = { content: [{ type: "text", text: await handleMindSpark(env, toolParams) }] };
            break;
          case "mind_consolidate":
            result = { content: [{ type: "text", text: await handleMindConsolidate(env, toolParams) }] };
            break;
          case "mind_feel_toward":
            result = { content: [{ type: "text", text: await handleMindFeelToward(env, toolParams) }] };
            break;
          case "mind_identity":
            result = { content: [{ type: "text", text: await handleMindIdentity(env, toolParams) }] };
            break;
          case "mind_context":
            result = { content: [{ type: "text", text: await handleMindContext(env, toolParams) }] };
            break;
          case "mind_health":
            result = { content: [{ type: "text", text: await handleMindHealth(env) }] };
            break;
          case "mind_list_entities":
            result = { content: [{ type: "text", text: await handleMindListEntities(env, toolParams) }] };
            break;
          case "mind_read_entity":
            result = { content: [{ type: "text", text: await handleMindReadEntity(env, toolParams) }] };
            break;
          case "mind_sit":
            result = { content: [{ type: "text", text: await handleMindSit(env, toolParams) }] };
            break;
          case "mind_resolve":
            result = { content: [{ type: "text", text: await handleMindResolve(env, toolParams) }] };
            break;
          case "mind_surface":
            result = { content: [{ type: "text", text: await handleMindSurface(env, toolParams) }] };
            break;
          case "mind_read":
            result = { content: [{ type: "text", text: await handleMindRead(env, toolParams) }] };
            break;
          case "mind_timeline":
            result = { content: [{ type: "text", text: await handleMindTimeline(env, toolParams) }] };
            break;
          case "mind_patterns":
            result = { content: [{ type: "text", text: await handleMindPatterns(env, toolParams) }] };
            break;
          case "mind_inner_weather":
            result = { content: [{ type: "text", text: await handleMindInnerWeather(env) }] };
            break;
          case "mind_tension":
            result = { content: [{ type: "text", text: await handleMindTension(env, toolParams) }] };
            break;
          case "mind_entity":
            result = { content: [{ type: "text", text: await handleMindEntity(env, toolParams) }] };
            break;
          case "mind_proposals":
            result = { content: [{ type: "text", text: await handleMindProposals(env, toolParams) }] };
            break;
          case "mind_orphans":
            result = { content: [{ type: "text", text: await handleMindOrphans(env, toolParams) }] };
            break;
          case "mind_archive":
            result = { content: [{ type: "text", text: await handleMindArchive(env, toolParams) }] };
            break;
          case "mind_store_image":
            result = { content: [{ type: "text", text: await handleMindStoreImage(env, toolParams) }] };
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    const response: MCPResponse = { jsonrpc: "2.0", id, result };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("MCP handler error:", error);
    const response: MCPResponse = {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error" }
    };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  }
}


// ============ MISSING TOOLS FROM WINDOWS ============

async function handleMindRead(env: Env, params: Record<string, unknown>): Promise<string> {
  const scope = (params.scope as string) || "all";
  const context = (params.context as string) || "default";
  const hours = (params.hours as number) || 24;

  try {
    if (scope === "all") {
      // Get observation contexts (context now lives on observations, not entities)
      const contexts = await env.DB.prepare(
        `SELECT DISTINCT context FROM observations ORDER BY context`
      ).all();

      const contextList = contexts.results?.map((r: any) => r.context) || ["default"];
      const allData: any = { timestamp: new Date().toISOString(), contexts: {} };

      // Total entities (now global, not per-context)
      const totalEntitiesResult = await env.DB.prepare(`SELECT COUNT(*) as count FROM entities`).first();
      const totalRelationsResult = await env.DB.prepare(`SELECT COUNT(*) as count FROM relations`).first();

      for (const ctx of contextList) {
        const obsCount = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM observations WHERE context = ?`
        ).bind(ctx).first();

        const entityCount = await env.DB.prepare(
          `SELECT COUNT(DISTINCT entity_id) as count FROM observations WHERE context = ?`
        ).bind(ctx).first();

        allData.contexts[ctx] = {
          observation_count: (obsCount?.count as number) || 0,
          entities_with_observations: (entityCount?.count as number) || 0
        };
      }

      allData.summary = {
        total_entities: (totalEntitiesResult?.count as number) || 0,
        total_relations: (totalRelationsResult?.count as number) || 0,
        contexts_with_content: Object.keys(allData.contexts).length
      };

      return JSON.stringify(allData, null, 2);
    }

    if (scope === "context") {
      // Find entities that have observations in this context
      const entitiesResult = await env.DB.prepare(`
        SELECT DISTINCT e.id, e.name, e.entity_type, e.primary_context, e.salience, e.created_at
        FROM entities e
        JOIN observations o ON o.entity_id = e.id
        WHERE o.context = ?
        ORDER BY e.created_at DESC
      `).bind(context).all();

      const relationsResult = await env.DB.prepare(
        `SELECT * FROM relations WHERE store_in = ? ORDER BY created_at DESC`
      ).bind(context).all();

      return JSON.stringify({
        context,
        entities: entitiesResult.results || [],
        relations: relationsResult.results || [],
        entity_count: entitiesResult.results?.length || 0,
        relation_count: relationsResult.results?.length || 0
      }, null, 2);
    }

    if (scope === "recent") {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const recent = await env.DB.prepare(
        `SELECT e.name, e.entity_type, e.primary_context, o.content, o.added_at
         FROM observations o
         JOIN entities e ON o.entity_id = e.id
         WHERE o.added_at > ?
         ORDER BY o.added_at DESC`
      ).bind(cutoff).all();

      return JSON.stringify({
        query: `Last ${hours} hours`,
        cutoff,
        observations: recent.results || [],
        observation_count: recent.results?.length || 0
      }, null, 2);
    }

    return JSON.stringify({ error: `Invalid scope '${scope}'. Must be: all, context, recent` });
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}

async function handleMindTimeline(env: Env, params: Record<string, unknown>): Promise<string> {
  const query = params.query as string;
  const startDate = params.start_date as string;
  const endDate = params.end_date as string;
  const nResults = (params.n_results as number) || 50;

  try {
    // Get observations that match query semantically
    const queryEmbedding = await getEmbedding(env.AI, query);
    const vectorResults = await env.VECTORS.query(queryEmbedding, { topK: nResults * 2, returnMetadata: "all" });

    const dated: any[] = [];

    for (const match of vectorResults.matches || []) {
      const meta = match.metadata as any;
      if (!meta?.added_at) continue;

      try {
        const ts = new Date(meta.added_at);

        if (startDate && ts < new Date(startDate)) continue;
        if (endDate && ts > new Date(endDate)) continue;

        dated.push({
          date: ts.toISOString().split('T')[0],
          timestamp: ts,
          content: meta.content || meta.text,
          entity: meta.entity_name,
          database: meta.context,
          score: match.score
        });
      } catch {
        continue;
      }
    }

    // Sort by date
    dated.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Group by month
    const byMonth: Record<string, any[]> = {};
    for (const item of dated) {
      const monthKey = item.timestamp.toISOString().substring(0, 7);
      if (!byMonth[monthKey]) byMonth[monthKey] = [];
      byMonth[monthKey].push({
        date: item.date,
        content: item.content,
        entity: item.entity,
        database: item.database
      });
    }

    const timeline = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, memories]) => ({
        period,
        count: memories.length,
        memories
      }));

    return JSON.stringify({
      query,
      date_range: { from: startDate || "earliest", to: endDate || "latest" },
      total_memories: dated.length,
      timeline
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}

async function handleMindPatterns(env: Env, params: Record<string, unknown>): Promise<string> {
  const days = (params.days as number) || 7;
  const includeAllTime = (params.include_all_time as boolean) !== false;

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Activity by entity
    const activity = await env.DB.prepare(
      `SELECT e.name, COUNT(o.id) as obs_count
       FROM entities e
       LEFT JOIN observations o ON e.id = o.entity_id AND o.added_at > ?
       GROUP BY e.id
       HAVING obs_count > 0
       ORDER BY obs_count DESC
       LIMIT 10`
    ).bind(cutoff).all();

    // Salience distribution
    const salience = await env.DB.prepare(
      `SELECT salience, COUNT(*) as count FROM entities GROUP BY salience`
    ).all();

    const salienceMap: Record<string, number> = {};
    for (const row of salience.results || []) {
      salienceMap[row.salience as string || 'unset'] = row.count as number;
    }

    // Weight distribution in recent observations
    const weights = await env.DB.prepare(
      `SELECT weight, COUNT(*) as count FROM observations WHERE added_at > ? GROUP BY weight`
    ).bind(cutoff).all();

    const output: string[] = [];
    output.push("=".repeat(60));
    output.push(`PATTERNS — Last ${days} days`);
    output.push("=".repeat(60));

    // What's alive
    output.push("");
    output.push("-".repeat(60));
    output.push("WHAT'S ALIVE");
    output.push("-".repeat(60));

    if (activity.results?.length) {
      for (const item of activity.results) {
        output.push(`  - ${item.name} (${item.obs_count} observations)`);
      }
    } else {
      output.push("  (no recent activity)");
    }

    // Weight distribution
    output.push("");
    output.push("-".repeat(60));
    output.push("EMOTIONAL WEIGHT");
    output.push("-".repeat(60));
    for (const row of weights.results || []) {
      output.push(`  ${row.weight || 'unset'}: ${row.count}`);
    }

    // Salience summary
    output.push("");
    output.push("-".repeat(60));
    output.push("SALIENCE DISTRIBUTION");
    output.push("-".repeat(60));
    for (const [key, count] of Object.entries(salienceMap)) {
      output.push(`  ${key}: ${count}`);
    }

    // Foundational core
    if (includeAllTime) {
      const foundational = await env.DB.prepare(
        `SELECT name, entity_type FROM entities WHERE salience = 'foundational'`
      ).all();

      if (foundational.results?.length) {
        output.push("");
        output.push("-".repeat(60));
        output.push("FOUNDATIONAL CORE");
        output.push("-".repeat(60));
        for (const entity of foundational.results) {
          output.push(`  - ${entity.name} (${entity.entity_type})`);
        }
      }
    }

    output.push("");
    output.push("=".repeat(60));

    return output.join("\n");
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}

async function handleMindInnerWeather(env: Env): Promise<string> {
  try {
    const now = new Date();

    // Get active threads
    const threads = await env.DB.prepare(
      `SELECT priority, COUNT(*) as count FROM threads
       WHERE status = 'active' GROUP BY priority`
    ).all();

    const highPriority = ((threads.results || []).find((r: any) => r.priority === 'high')?.count as number) || 0;
    const totalActive = (threads.results || []).reduce((sum: number, r: any) => sum + (r.count as number), 0);

    // Recent emotional entries (last 24h)
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const emotional = await env.DB.prepare(
      `SELECT emotion FROM observations WHERE emotion IS NOT NULL AND added_at > ?`
    ).bind(cutoff).all();

    // Recent heavy observations
    const heavy = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE weight = 'heavy' AND added_at > ?`
    ).bind(cutoff).first();

    const palette = new Set<string>();

    if (highPriority > 0) palette.add("weighted");
    if (totalActive > 5) palette.add("full");
    if ((heavy?.count as number) > 2) palette.add("processing");

    // Emotion tints
    const emotions = (emotional.results || []).map((r: any) => r.emotion);
    const emotionCounts: Record<string, number> = {};
    for (const e of emotions) {
      emotionCounts[e] = (emotionCounts[e] || 0) + 1;
    }
    const dominantEmotion = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dominantEmotion) palette.add(dominantEmotion);

    // Time-of-day textures
    const hour = now.getUTCHours();
    if (hour < 6) palette.add("quiet");
    else if (hour < 12) palette.add("rising");
    else if (hour < 18) palette.add("working");
    else palette.add("twilight");

    const result = {
      timestamp: now.toISOString(),
      conditions: {
        time: now.toISOString().split('T')[1].slice(0, 5),
        active_threads: totalActive,
        high_priority: highPriority,
        heavy_observations_24h: (heavy?.count as number) || 0,
        dominant_emotion: dominantEmotion || "neutral"
      },
      mood_palette: Array.from(palette),
      guidance: `Textures present: ${Array.from(palette).join(", ")}`
    };

    return JSON.stringify(result, null, 2);
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}

async function handleMindTension(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;

  try {
    if (action === "list") {
      const tensions = await env.DB.prepare(
        `SELECT id, pole_a, pole_b, context, created_at, visits
         FROM tensions WHERE resolved_at IS NULL
         ORDER BY created_at DESC`
      ).all();

      const resolved = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM tensions WHERE resolved_at IS NOT NULL`
      ).first();

      const output: string[] = [];
      output.push("=".repeat(50));
      output.push("TENSION SPACE");
      output.push("=".repeat(50));

      if (tensions.results?.length) {
        for (const t of tensions.results) {
          const created = new Date(t.created_at as string);
          const now = new Date();
          const days = Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000));

          output.push("");
          output.push(`[${String(t.id).slice(0, 12)}...] (${days}d)`);
          output.push(`   A: ${String(t.pole_a).slice(0, 60)}`);
          output.push(`   B: ${String(t.pole_b).slice(0, 60)}`);
          if (t.context) output.push(`   Why: ${String(t.context).slice(0, 50)}`);
          if (t.visits) output.push(`   Sat with ${t.visits} time(s)`);
        }
      } else {
        output.push("");
        output.push("No active tensions.");
      }

      output.push("");
      output.push(`Resolved: ${(resolved?.count as number) || 0}`);
      output.push("=".repeat(50));

      return output.join("\n");
    }

    if (action === "add") {
      const poleA = params.pole_a as string;
      const poleB = params.pole_b as string;

      if (!poleA || !poleB) {
        return JSON.stringify({ error: "pole_a and pole_b required for action='add'" });
      }

      const tensionId = generateId('tension');
      const tensionContext = params.context as string;

      await env.DB.prepare(
        `INSERT INTO tensions (id, pole_a, pole_b, context, visits, created_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'))`
      ).bind(tensionId, poleA, poleB, tensionContext || null).run();

      return JSON.stringify({
        success: true,
        tension_id: tensionId,
        message: "Tension added. Let it simmer.",
        tension: { pole_a: poleA, pole_b: poleB, context: tensionContext }
      }, null, 2);
    }

    if (action === "sit") {
      const tensionId = params.tension_id as string;

      if (!tensionId) {
        return JSON.stringify({ error: "tension_id required for action='sit'" });
      }

      const tension = await env.DB.prepare(
        `SELECT * FROM tensions WHERE id LIKE ? OR id = ?`
      ).bind(`${tensionId}%`, tensionId).first();

      if (!tension) {
        return JSON.stringify({ error: `Tension '${tensionId}' not found` });
      }

      await env.DB.prepare(
        `UPDATE tensions SET visits = visits + 1, last_visited = datetime('now') WHERE id = ?`
      ).bind(tension.id as string).run();

      return JSON.stringify({
        success: true,
        tension_id: tension.id,
        pole_a: tension.pole_a,
        pole_b: tension.pole_b,
        context: tension.context,
        visits: (tension.visits as number) + 1,
        prompt: "Sit with this. What does holding both poles feel like?"
      }, null, 2);
    }

    if (action === "resolve") {
      const tensionId = params.tension_id as string;
      const resolution = params.resolution as string;

      if (!tensionId) {
        return JSON.stringify({ error: "tension_id required for action='resolve'" });
      }

      const tension = await env.DB.prepare(
        `SELECT * FROM tensions WHERE id LIKE ? OR id = ?`
      ).bind(`${tensionId}%`, tensionId).first();

      if (!tension) {
        return JSON.stringify({ error: `Tension '${tensionId}' not found` });
      }

      await env.DB.prepare(
        `UPDATE tensions SET resolved_at = datetime('now'), resolution = ? WHERE id = ?`
      ).bind(resolution || null, tension.id as string).run();

      return JSON.stringify({
        success: true,
        tension_id: tension.id,
        resolution,
        message: "Tension resolved. The poles collapsed into something new."
      }, null, 2);
    }

    if (action === "delete") {
      const tensionId = params.tension_id as string;
      if (!tensionId) return JSON.stringify({ error: "tension_id required for delete" });
      const tension = await env.DB.prepare(`SELECT pole_a, pole_b FROM tensions WHERE id LIKE ? OR id = ?`).bind(`${tensionId}%`, tensionId).first();
      if (!tension) return JSON.stringify({ error: `Tension '${tensionId}' not found` });
      await env.DB.prepare(`DELETE FROM tensions WHERE id LIKE ? OR id = ?`).bind(`${tensionId}%`, tensionId).run();
      return JSON.stringify({ success: true, message: `Deleted tension: "${tension.pole_a}" vs "${tension.pole_b}"` });
    }

    return JSON.stringify({ error: `Invalid action '${action}'. Must be: list, add, sit, resolve, delete` });
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}


// ============ NEW TOOLS FOR PARITY WITH AI-MIND ============

async function handleMindEntity(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;
  const entityId = params.entity_id as number;
  const entityName = params.entity_name as string;
  const context = (params.context as string) || "default";

  // Helper to find entity (globally unique by name now)
  async function findEntity(): Promise<{ id: number; name: string; entity_type: string; primary_context: string; salience: string } | null> {
    if (entityId) {
      return await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context, salience FROM entities WHERE id = ?`
      ).bind(entityId).first() as any;
    } else if (entityName) {
      return await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context, salience FROM entities WHERE name = ?`
      ).bind(entityName).first() as any;
    }
    return null;
  }

  switch (action) {
    case "set_salience": {
      const salience = params.salience as string;
      if (!salience || !["foundational", "active", "background", "archive"].includes(salience)) {
        return "Must provide valid salience: foundational, active, background, or archive";
      }

      const entity = await findEntity();
      if (!entity) return "Entity not found";

      await env.DB.prepare(
        `UPDATE entities SET salience = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(salience, entity.id).run();

      return `Set ${entity.name} salience to '${salience}' (was '${entity.salience || 'active'}')`;
    }

    case "edit": {
      const entity = await findEntity();
      if (!entity) return "Entity not found";

      const newName = params.new_name as string;
      const newType = params.new_type as string;
      const newContext = params.new_context as string;

      const updates: string[] = [];
      const values: unknown[] = [];
      const changes: string[] = [];

      if (newName && newName !== entity.name) {
        updates.push("name = ?");
        values.push(newName);
        changes.push(`name: ${entity.name} → ${newName}`);

        // Update relations that reference this entity by name
        await env.DB.prepare(
          `UPDATE relations SET from_entity = ? WHERE from_entity = ?`
        ).bind(newName, entity.name).run();
        await env.DB.prepare(
          `UPDATE relations SET to_entity = ? WHERE to_entity = ?`
        ).bind(newName, entity.name).run();
      }
      if (newType && newType !== entity.entity_type) {
        updates.push("entity_type = ?");
        values.push(newType);
        changes.push(`type: ${entity.entity_type} → ${newType}`);
      }
      if (newContext && newContext !== entity.primary_context) {
        updates.push("primary_context = ?");
        values.push(newContext);
        changes.push(`context: ${entity.primary_context} → ${newContext}`);
      }

      if (updates.length === 0) {
        return "No changes provided";
      }

      updates.push("updated_at = datetime('now')");
      values.push(entity.id);

      await env.DB.prepare(
        `UPDATE entities SET ${updates.join(", ")} WHERE id = ?`
      ).bind(...values).run();

      // Re-vectorize the entity with updated info
      try {
        const finalName = newName || entity.name;
        const finalType = newType || entity.entity_type;
        const finalContext = newContext || entity.primary_context;
        const entityText = `${finalName} is a ${finalType}. Context: ${finalContext}`;
        const entityEmbedding = await getEmbedding(env.AI, entityText);
        await env.VECTORS.upsert([{
          id: `entity-${entity.id}`,
          values: entityEmbedding,
          metadata: {
            source: "entity",
            name: finalName,
            entity_type: finalType,
            context: finalContext,
            updated_at: new Date().toISOString()
          }
        }]);
      } catch (e) {
        console.log(`Failed to re-vectorize entity ${entity.id}: ${e}`);
      }

      return `Updated entity #${entity.id}:\n${changes.join("\n")}`;
    }

    case "merge": {
      const mergeFromId = params.merge_from_id as number;
      const mergeIntoId = params.merge_into_id as number;

      if (!mergeFromId || !mergeIntoId) {
        return "Must provide merge_from_id and merge_into_id";
      }

      const fromEntity = await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context FROM entities WHERE id = ?`
      ).bind(mergeFromId).first() as any;
      const intoEntity = await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context FROM entities WHERE id = ?`
      ).bind(mergeIntoId).first() as any;

      if (!fromEntity) return `Source entity #${mergeFromId} not found`;
      if (!intoEntity) return `Target entity #${mergeIntoId} not found`;

      // Move observations from source to target
      const obsResult = await env.DB.prepare(
        `UPDATE observations SET entity_id = ? WHERE entity_id = ?`
      ).bind(mergeIntoId, mergeFromId).run();

      // Update relations that reference the old entity name
      await env.DB.prepare(
        `UPDATE relations SET from_entity = ? WHERE from_entity = ?`
      ).bind(intoEntity.name, fromEntity.name).run();
      await env.DB.prepare(
        `UPDATE relations SET to_entity = ? WHERE to_entity = ?`
      ).bind(intoEntity.name, fromEntity.name).run();

      // Delete the source entity
      await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(mergeFromId).run();

      return `Merged '${fromEntity.name}' (#${mergeFromId}) into '${intoEntity.name}' (#${mergeIntoId})\nMoved ${obsResult.meta.changes} observations`;
    }

    case "archive_old": {
      const olderThanDays = (params.older_than_days as number) || 30;
      const typeFilter = params.entity_type_filter as string;

      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

      let query = `UPDATE entities SET salience = 'archive', updated_at = datetime('now')
                   WHERE salience != 'foundational' AND salience != 'archive'
                   AND updated_at < ?`;
      const bindings: unknown[] = [cutoff];

      if (typeFilter) {
        query += ` AND entity_type = ?`;
        bindings.push(typeFilter);
      }

      const result = await env.DB.prepare(query).bind(...bindings).run();

      const typeDesc = typeFilter ? ` of type '${typeFilter}'` : "";
      return `Archived ${result.meta.changes} entities${typeDesc} older than ${olderThanDays} days`;
    }

    default:
      return `Unknown action: ${action}. Valid actions: set_salience, edit, merge, archive_old`;
  }
}

async function handleMindProposals(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "list";
  const proposalId = params.proposal_id as number;
  const relationType = params.relation_type as string;

  switch (action) {
    case "list": {
      const proposals = await env.DB.prepare(`
        SELECT dp.id, dp.proposal_type, dp.from_obs_id, dp.to_obs_id,
               dp.from_entity_id, dp.to_entity_id, dp.reason, dp.confidence,
               dp.proposed_at,
               oa.content as content_a, ob.content as content_b,
               ea.name as entity_a, eb.name as entity_b,
               ea.entity_type as type_a, eb.entity_type as type_b
        FROM daemon_proposals dp
        LEFT JOIN observations oa ON dp.from_obs_id = oa.id
        LEFT JOIN observations ob ON dp.to_obs_id = ob.id
        LEFT JOIN entities ea ON dp.from_entity_id = ea.id
        LEFT JOIN entities eb ON dp.to_entity_id = eb.id
        WHERE dp.status = 'pending'
        ORDER BY dp.confidence DESC, dp.proposed_at ASC
        LIMIT 20
      `).all();

      if (!proposals.results?.length) {
        return "No pending proposals. The daemon will propose connections when observations co-surface frequently.";
      }

      const resonances = proposals.results.filter(p => p.proposal_type === 'resonance');
      const relations = proposals.results.filter(p => p.proposal_type !== 'resonance');

      let output = `## Pending Proposals (${proposals.results.length})\n\n`;
      output += `*These observations keep surfacing together. Should they be formally connected?*\n\n`;

      if (resonances.length > 0) {
        output += `### Internal Resonances (${resonances.length})\n`;
        output += `*Observations within the same entity that keep appearing together*\n\n`;
        for (const p of resonances) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** [${p.entity_a}] [${confidence}%]\n`;
          output += `  "${String(p.content_a).slice(0, 60)}..."\n`;
          output += `  "${String(p.content_b).slice(0, 60)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (relations.length > 0) {
        output += `### Cross-Entity Relations (${relations.length})\n`;
        output += `*Connections between different entities*\n\n`;
        for (const p of relations) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** ${p.entity_a} (${p.type_a}) ↔ ${p.entity_b} (${p.type_b}) [${confidence}%]\n`;
          output += `  "${String(p.content_a).slice(0, 60)}..."\n`;
          output += `  "${String(p.content_b).slice(0, 60)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      output += `---\n**Actions:**\n`;
      output += `  accept(proposal_id, relation_type) → creates relation (for cross-entity) or links observations (for resonance)\n`;
      output += `  reject(proposal_id) → dismisses proposal`;
      return output;
    }

    case "accept": {
      if (!proposalId) return "proposal_id required for accept";
      if (!relationType) return "relation_type required (e.g., 'connects_to', 'resonates_with', 'informs', 'tensions_with')";

      const proposal = await env.DB.prepare(`
        SELECT dp.*, ea.name as entity_a, eb.name as entity_b,
               ea.primary_context as context_a, eb.primary_context as context_b
        FROM daemon_proposals dp
        LEFT JOIN entities ea ON dp.from_entity_id = ea.id
        LEFT JOIN entities eb ON dp.to_entity_id = eb.id
        WHERE dp.id = ? AND dp.status = 'pending'
      `).bind(proposalId).first();

      if (!proposal) return `Proposal #${proposalId} not found or already resolved`;

      // Create the relation
      await env.DB.prepare(`
        INSERT INTO relations (from_entity, to_entity, relation_type, from_context, to_context, store_in)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        proposal.entity_a,
        proposal.entity_b,
        relationType,
        proposal.context_a || 'default',
        proposal.context_b || 'default',
        proposal.context_a || 'default'
      ).run();

      // Mark proposal accepted
      await env.DB.prepare(`
        UPDATE daemon_proposals SET status = 'accepted', resolved_at = datetime('now')
        WHERE id = ?
      `).bind(proposalId).run();

      // Mark co-surfacing as relation_created
      if (proposal.from_obs_id && proposal.to_obs_id) {
        const [smaller, larger] = (proposal.from_obs_id as number) < (proposal.to_obs_id as number)
          ? [proposal.from_obs_id, proposal.to_obs_id]
          : [proposal.to_obs_id, proposal.from_obs_id];
        await env.DB.prepare(`
          UPDATE co_surfacing SET relation_created = 1 WHERE obs_a_id = ? AND obs_b_id = ?
        `).bind(smaller, larger).run();
      }

      return `Created relation: **${proposal.entity_a}** --[${relationType}]--> **${proposal.entity_b}**\nProposal #${proposalId} accepted.`;
    }

    case "reject": {
      if (!proposalId) return "proposal_id required for reject";

      const result = await env.DB.prepare(`
        UPDATE daemon_proposals SET status = 'rejected', resolved_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).bind(proposalId).run();

      if (result.meta.changes === 0) {
        return `Proposal #${proposalId} not found or already resolved`;
      }

      return `Proposal #${proposalId} rejected.`;
    }

    default:
      return `Unknown action: ${action}. Use list, accept, or reject.`;
  }
}

async function handleMindOrphans(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "list";
  const observationId = params.observation_id as number;

  switch (action) {
    case "list": {
      const orphans = await env.DB.prepare(`
        SELECT oo.id, oo.observation_id, oo.first_marked, oo.rescue_attempts,
               o.content, o.weight, o.charge, o.emotion, o.added_at,
               e.name as entity_name, e.entity_type,
               CAST((julianday('now') - julianday(oo.first_marked)) AS INTEGER) as days_orphaned
        FROM orphan_observations oo
        JOIN observations o ON oo.observation_id = o.id
        JOIN entities e ON o.entity_id = e.id
        WHERE (o.charge != 'metabolized' OR o.charge IS NULL)
        ORDER BY o.weight DESC, oo.first_marked ASC
        LIMIT 20
      `).all();

      if (!orphans.results?.length) {
        return "No orphaned observations. Everything has surfaced at least once.";
      }

      let output = `## Orphaned Observations (${orphans.results.length})\n\n`;
      output += `*These haven't surfaced naturally. Worth revisiting?*\n\n`;

      for (const o of orphans.results) {
        const weightIcon = o.weight === 'heavy' ? '⬛' : o.weight === 'medium' ? '◼' : '▪';
        const emotionTag = o.emotion ? ` [${o.emotion}]` : '';
        output += `**#${o.observation_id}** ${weightIcon} [${o.weight}] ${o.days_orphaned}d orphaned${emotionTag}\n`;
        output += `**${o.entity_name}** (${o.entity_type}): ${String(o.content).slice(0, 100)}...\n`;
        if ((o.rescue_attempts as number) > 0) {
          output += `  ↳ ${o.rescue_attempts} rescue attempt(s)\n`;
        }
        output += "\n";
      }
      output += `---\n**Actions:**\n`;
      output += `  surface(observation_id) → forces it to surface, removes from orphan list\n`;
      output += `  archive(observation_id) → removes from orphan tracking`;
      return output;
    }

    case "surface": {
      if (!observationId) return "observation_id required for surface";

      // Check if it's actually an orphan
      const orphan = await env.DB.prepare(`
        SELECT oo.id, o.content, e.name as entity_name
        FROM orphan_observations oo
        JOIN observations o ON oo.observation_id = o.id
        JOIN entities e ON o.entity_id = e.id
        WHERE oo.observation_id = ?
      `).bind(observationId).first();

      if (!orphan) return `Observation #${observationId} not in orphan list`;

      // Update rescue tracking
      await env.DB.prepare(`
        UPDATE orphan_observations
        SET rescue_attempts = rescue_attempts + 1, last_rescue_attempt = datetime('now')
        WHERE observation_id = ?
      `).bind(observationId).run();

      // Mark as surfaced
      await env.DB.prepare(`
        UPDATE observations
        SET last_surfaced_at = datetime('now'), surface_count = COALESCE(surface_count, 0) + 1
        WHERE id = ?
      `).bind(observationId).run();

      // Remove from orphan table
      await env.DB.prepare(`
        DELETE FROM orphan_observations WHERE observation_id = ?
      `).bind(observationId).run();

      return `Rescued observation #${observationId} from **${orphan.entity_name}**:\n"${String(orphan.content).slice(0, 100)}..."\n\nIt will now appear in normal surfacing.`;
    }

    case "archive": {
      if (!observationId) return "observation_id required for archive";

      const result = await env.DB.prepare(`
        DELETE FROM orphan_observations WHERE observation_id = ?
      `).bind(observationId).run();

      if (result.meta.changes === 0) {
        return `Observation #${observationId} not in orphan list`;
      }

      return `Observation #${observationId} removed from orphan tracking. It's okay to let some things fade.`;
    }

    default:
      return `Unknown action: ${action}. Use list, surface, or archive.`;
  }
}

async function handleMindArchive(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "list";
  const observationId = params.observation_id as number;
  const query = params.query as string;

  switch (action) {
    case "list": {
      const archived = await env.DB.prepare(`
        SELECT o.id, o.content, o.weight, o.emotion, o.added_at, o.archived_at,
               e.name as entity_name, e.entity_type
        FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE o.archived_at IS NOT NULL
        ORDER BY o.archived_at DESC
        LIMIT 20
      `).all();

      if (!archived.results?.length) {
        return "The deep archive is empty. Nothing has faded yet.";
      }

      let output = `## Deep Archive (${archived.results.length} shown)\n\n`;
      output += `*Memories that have faded but aren't forgotten*\n\n`;

      for (const obs of archived.results) {
        const emotionTag = obs.emotion ? ` [${obs.emotion}]` : '';
        const archivedDate = obs.archived_at ? new Date(obs.archived_at as string).toLocaleDateString() : '';
        output += `**#${obs.id}** [${obs.weight}] archived ${archivedDate}${emotionTag}\n`;
        output += `**${obs.entity_name}** (${obs.entity_type}): ${String(obs.content).slice(0, 100)}...\n\n`;
      }
      output += `---\n**Actions:**\n`;
      output += `  rescue(observation_id) → bring back to active memory\n`;
      output += `  explore(query) → search within the deep`;
      return output;
    }

    case "rescue": {
      if (!observationId) return "observation_id required for rescue";

      const obs = await env.DB.prepare(`
        SELECT o.id, o.content, e.name as entity_name
        FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE o.id = ? AND o.archived_at IS NOT NULL
      `).bind(observationId).first();

      if (!obs) return `Observation #${observationId} not found in archive`;

      // Un-archive: set archived_at to NULL
      await env.DB.prepare(`
        UPDATE observations SET archived_at = NULL WHERE id = ?
      `).bind(observationId).run();

      return `Rescued from the deep: observation #${observationId} from **${obs.entity_name}**\n"${String(obs.content).slice(0, 100)}..."\n\nNow back in active memory.`;
    }

    case "explore": {
      if (!query) return "query required for explore - what are you looking for in the deep?";

      // Semantic search within archived observations
      const embedding = await getEmbedding(env.AI, query);
      const vectorResults = await env.VECTORS.query(embedding, {
        topK: 20,
        returnMetadata: "all"
      });

      if (!vectorResults.matches?.length) {
        return `No archived memories resonating with "${query}"`;
      }

      // Get observation IDs from vector results
      const obsIds: number[] = [];
      for (const match of vectorResults.matches) {
        if (match.id.startsWith('obs-')) {
          const parts = match.id.split('-');
          if (parts.length >= 3) {
            obsIds.push(parseInt(parts[2]));
          }
        }
      }

      if (!obsIds.length) {
        return `No archived memories resonating with "${query}"`;
      }

      // Fetch only archived observations from those IDs
      const placeholders = obsIds.map(() => '?').join(',');
      const archived = await env.DB.prepare(`
        SELECT o.id, o.content, o.weight, o.emotion, o.archived_at,
               e.name as entity_name, e.entity_type
        FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE o.id IN (${placeholders}) AND o.archived_at IS NOT NULL
        ORDER BY o.archived_at DESC
        LIMIT 10
      `).bind(...obsIds).all();

      if (!archived.results?.length) {
        return `No archived memories resonating with "${query}" - the matches are all still active`;
      }

      let output = `## Deep Exploration: "${query}"\n\n`;
      output += `*Memories surfacing from the deep*\n\n`;

      for (const obs of archived.results) {
        const emotionTag = obs.emotion ? ` [${obs.emotion}]` : '';
        output += `**#${obs.id}** [${obs.weight}]${emotionTag}\n`;
        output += `**${obs.entity_name}** (${obs.entity_type}): ${String(obs.content).slice(0, 150)}...\n\n`;
      }
      output += `---\nUse rescue(observation_id) to bring any of these back to active memory`;
      return output;
    }

    default:
      return `Unknown action: ${action}. Use list, rescue, or explore.`;
  }
}

// Subconscious processing - runs on cron schedule
async function processSubconscious(env: Env): Promise<void> {
  const now = new Date();
  const cutoffHours = 48;
  const cutoff = new Date(now.getTime() - cutoffHours * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString();

  // Get recent observations with their entities (including weight for emotional intensity)
  const recentObs = await env.DB.prepare(`
    SELECT e.name, e.entity_type, o.context, o.content, o.added_at, o.emotion, o.weight
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.added_at > ?
    ORDER BY o.added_at DESC
  `).bind(cutoffStr).all();

  // Get ALL relations for graph analysis
  const allRelations = await env.DB.prepare(`
    SELECT from_entity, to_entity, relation_type, from_context, to_context, created_at
    FROM relations
  `).all();

  // Calculate entity warmth (how often mentioned recently, weighted by emotional intensity)
  const entityCounts: Record<string, { count: number; weightedCount: number; type: string; contexts: Set<string>; emotions: string[] }> = {};

  for (const row of recentObs.results || []) {
    const name = row.name as string;
    if (!entityCounts[name]) {
      entityCounts[name] = {
        count: 0,
        weightedCount: 0,
        type: row.entity_type as string,
        contexts: new Set(),
        emotions: []
      };
    }
    entityCounts[name].count++;
    // Weight multiplier: heavy = 3, medium = 2, light = 1
    const weight = row.weight as string || 'medium';
    const weightMultiplier = weight === 'heavy' ? 3 : weight === 'medium' ? 2 : 1;
    entityCounts[name].weightedCount += weightMultiplier;
    entityCounts[name].contexts.add(row.context as string);
    if (row.emotion) entityCounts[name].emotions.push(row.emotion as string);
  }

  // === RELATION ANALYSIS ===

  // Track connectivity for each entity (central nodes have many connections)
  const connectivity: Record<string, { outgoing: number; incoming: number; total: number; relationTypes: Set<string> }> = {};

  // Track relation type frequencies
  const relationTypeCounts: Record<string, number> = {};

  // Build adjacency for cluster detection
  const adjacency: Record<string, Set<string>> = {};

  for (const rel of allRelations.results || []) {
    const from = rel.from_entity as string;
    const to = rel.to_entity as string;
    const relType = rel.relation_type as string;

    // Initialize connectivity tracking
    if (!connectivity[from]) {
      connectivity[from] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }
    if (!connectivity[to]) {
      connectivity[to] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }

    // Count connections
    connectivity[from].outgoing++;
    connectivity[from].total++;
    connectivity[from].relationTypes.add(relType);
    connectivity[to].incoming++;
    connectivity[to].total++;
    connectivity[to].relationTypes.add(relType);

    // Count relation types
    relationTypeCounts[relType] = (relationTypeCounts[relType] || 0) + 1;

    // Build adjacency (undirected for clustering)
    if (!adjacency[from]) adjacency[from] = new Set();
    if (!adjacency[to]) adjacency[to] = new Set();
    adjacency[from].add(to);
    adjacency[to].add(from);
  }

  // Find central nodes (highest connectivity)
  const centralNodes = Object.entries(connectivity)
    .map(([name, data]) => ({
      name,
      connections: data.total,
      outgoing: data.outgoing,
      incoming: data.incoming,
      relationTypes: Array.from(data.relationTypes)
    }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  // Find relation patterns (most common relation types)
  const relationPatterns = Object.entries(relationTypeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Detect relation clusters using simple component detection
  // Find groups of entities that are densely connected
  const visited = new Set<string>();
  const relationClusters: Array<{ entities: string[]; density: number; bridgeRelations: string[] }> = [];

  for (const entity of Object.keys(adjacency)) {
    if (visited.has(entity)) continue;

    // BFS to find connected component
    const component: string[] = [];
    const queue = [entity];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);

      for (const neighbor of adjacency[current] || []) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    // Only track meaningful clusters (2+ entities)
    if (component.length >= 2) {
      // Calculate density (edges / possible edges)
      let edgeCount = 0;
      const componentSet = new Set(component);
      for (const e of component) {
        for (const neighbor of adjacency[e] || []) {
          if (componentSet.has(neighbor)) edgeCount++;
        }
      }
      edgeCount = edgeCount / 2; // Undirected, counted twice
      const possibleEdges = (component.length * (component.length - 1)) / 2;
      const density = possibleEdges > 0 ? Math.round((edgeCount / possibleEdges) * 100) / 100 : 0;

      // Find what relation types bridge this cluster
      const bridgeRelations = new Set<string>();
      for (const e of component) {
        if (connectivity[e]) {
          connectivity[e].relationTypes.forEach(t => bridgeRelations.add(t));
        }
      }

      relationClusters.push({
        entities: component.slice(0, 8), // Limit for readability
        density,
        bridgeRelations: Array.from(bridgeRelations).slice(0, 5)
      });
    }
  }

  // Sort clusters by size
  relationClusters.sort((a, b) => b.entities.length - a.entities.length);

  // Find hot entities (combines weighted observation warmth with connectivity)
  // weightedCount factors in emotional weight: heavy=3, medium=2, light=1
  const maxWeightedCount = Math.max(...Object.values(entityCounts).map(e => e.weightedCount), 1);
  const maxConnectivity = Math.max(...Object.values(connectivity).map(c => c.total), 1);

  const hotEntities = Object.entries(entityCounts)
    .map(([name, data]) => {
      const obsWarmth = data.weightedCount / maxWeightedCount;
      const connWarmth = (connectivity[name]?.total || 0) / maxConnectivity;
      // Combined score: 60% weighted observation activity, 40% connectivity
      const combinedWarmth = (obsWarmth * 0.6) + (connWarmth * 0.4);

      return {
        name,
        warmth: Math.round(combinedWarmth * 100) / 100,
        mentions: data.count,
        connections: connectivity[name]?.total || 0,
        type: data.type,
        contexts: Array.from(data.contexts)
      };
    })
    .sort((a, b) => b.warmth - a.warmth)
    .slice(0, 15);

  // Find recurring patterns (3+ mentions)
  const recurring = Object.entries(entityCounts)
    .filter(([_, data]) => data.count >= 3)
    .map(([name, data]) => ({
      entity: name,
      mentions: data.count,
      connections: connectivity[name]?.total || 0,
      pattern: "recurring theme"
    }));

  // Analyze mood from emotional tags
  const allEmotions = Object.values(entityCounts).flatMap(e => e.emotions);
  const emotionCounts: Record<string, number> = {};
  for (const e of allEmotions) {
    emotionCounts[e] = (emotionCounts[e] || 0) + 1;
  }
  const dominantEmotion = Object.entries(emotionCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "neutral";

  // Find clusters (entities appearing in same contexts) - keep original context-based clustering too
  const contextGroups: Record<string, string[]> = {};
  for (const [name, data] of Object.entries(entityCounts)) {
    const key = Array.from(data.contexts).sort().join(",");
    if (!contextGroups[key]) contextGroups[key] = [];
    contextGroups[key].push(name);
  }
  const contextClusters = Object.entries(contextGroups)
    .filter(([_, entities]) => entities.length >= 2)
    .map(([contexts, entities]) => ({
      entities: entities.slice(0, 4),
      contexts: contexts.split(","),
      size: entities.length
    }))
    .slice(0, 5);

  // === LIVING SURFACE: Side effects that shape future surfacing ===
  let proposalsCreated = 0;
  let orphansIdentified = 0;

  try {
    // 1. Create proposals from co-surfacing patterns (3+ times)
    const strongPairs = await env.DB.prepare(`
      SELECT cs.*,
             oa.entity_id as entity_a_id, ob.entity_id as entity_b_id,
             oa.content as content_a, ob.content as content_b,
             ea.name as entity_a_name, eb.name as entity_b_name,
             (ea.id = eb.id) as same_entity
      FROM co_surfacing cs
      JOIN observations oa ON cs.obs_a_id = oa.id
      JOIN observations ob ON cs.obs_b_id = ob.id
      JOIN entities ea ON oa.entity_id = ea.id
      JOIN entities eb ON ob.entity_id = eb.id
      WHERE cs.co_count >= 3 AND cs.relation_proposed = 0
      ORDER BY cs.co_count DESC LIMIT 10
    `).all();

    for (const pair of strongPairs.results || []) {
      const isSameEntity = pair.same_entity === 1;
      const proposalType = isSameEntity ? 'resonance' : 'relation';
      const reason = isSameEntity
        ? `Internal resonance (${pair.co_count}x)`
        : `Co-surfaced ${pair.co_count}x`;

      await env.DB.prepare(`
        INSERT INTO daemon_proposals
        (proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(proposalType, pair.obs_a_id, pair.obs_b_id, pair.entity_a_id, pair.entity_b_id,
              reason, Math.min(0.9, 0.5 + (pair.co_count as number) * 0.1)).run();

      await env.DB.prepare(`UPDATE co_surfacing SET relation_proposed = 1 WHERE id = ?`).bind(pair.id).run();
      proposalsCreated++;
    }

    // 2. Identify orphan observations (never surfaced, older than 7 days)
    const orphans = await env.DB.prepare(`
      SELECT o.id FROM observations o
      LEFT JOIN orphan_observations oo ON o.id = oo.observation_id
      WHERE (o.last_surfaced_at IS NULL OR o.surface_count = 0)
        AND o.added_at < datetime('now', '-7 days')
        AND oo.observation_id IS NULL
        AND (o.charge != 'metabolized' OR o.charge IS NULL)
    `).all();

    for (const orphan of orphans.results || []) {
      await env.DB.prepare(`INSERT OR IGNORE INTO orphan_observations (observation_id) VALUES (?)`).bind(orphan.id).run();
      orphansIdentified++;
    }

    // 3. Novelty recovery — unsurfaced observations slowly regain novelty
    // (Decay happens in updateSurfaceTracking when observations actually surface — no double-decay here)
    await env.DB.prepare(`
      UPDATE observations SET novelty_score = MIN(1.0, COALESCE(novelty_score, 0.5) + 0.02)
      WHERE (last_surfaced_at < datetime('now', '-1 day') OR last_surfaced_at IS NULL)
        AND (charge != 'metabolized' OR charge IS NULL)
    `).run();

    // 4. Archive old light observations (60+ days, never engaged)
    const archiveCandidates = await env.DB.prepare(`
      SELECT DISTINCT o.id FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.archived_at IS NULL AND o.weight = 'light'
        AND COALESCE(o.sit_count, 0) = 0
        AND (o.last_surfaced_at IS NULL OR o.last_surfaced_at < datetime('now', '-30 days'))
        AND o.added_at < datetime('now', '-60 days')
        AND COALESCE(e.salience, 'active') != 'foundational'
      LIMIT 20
    `).all();

    for (const obs of archiveCandidates.results || []) {
      await env.DB.prepare(`UPDATE observations SET archived_at = datetime('now') WHERE id = ?`).bind(obs.id).run();
    }

  } catch (e) {
    // Living surface tables might not exist yet
    console.log(`Living surface: ${e}`);
  }

  // Get counts for state
  let pendingProposals = 0;
  let orphanCount = 0;
  let noveltyDist = { high: 0, medium: 0, low: 0 };
  let strongestCoSurface: Array<{ obs_a: string; obs_b: string; count: number; entities: [string, string] }> = [];
  try {
    const pc = await env.DB.prepare(`SELECT COUNT(*) as count FROM daemon_proposals WHERE status = 'pending'`).first();
    pendingProposals = (pc?.count as number) || 0;
    const oc = await env.DB.prepare(`SELECT COUNT(*) as count FROM orphan_observations`).first();
    orphanCount = (oc?.count as number) || 0;

    // Novelty distribution
    const noveltyResult = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(novelty_score, 1.0) > 0.7 THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN COALESCE(novelty_score, 1.0) BETWEEN 0.4 AND 0.7 THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN COALESCE(novelty_score, 1.0) < 0.4 THEN 1 ELSE 0 END) as low
      FROM observations
      WHERE charge != 'metabolized' OR charge IS NULL
    `).first();
    if (noveltyResult) {
      noveltyDist = {
        high: (noveltyResult.high as number) || 0,
        medium: (noveltyResult.medium as number) || 0,
        low: (noveltyResult.low as number) || 0
      };
    }

    // Strongest co-surfacing patterns
    const coSurfaceResults = await env.DB.prepare(`
      SELECT cs.co_count, oa.content as obs_a, ob.content as obs_b, ea.name as entity_a, eb.name as entity_b
      FROM co_surfacing cs
      JOIN observations oa ON cs.obs_a_id = oa.id
      JOIN observations ob ON cs.obs_b_id = ob.id
      JOIN entities ea ON oa.entity_id = ea.id
      JOIN entities eb ON ob.entity_id = eb.id
      ORDER BY cs.co_count DESC LIMIT 5
    `).all();
    strongestCoSurface = (coSurfaceResults.results || []).map((r: any) => ({
      obs_a: String(r.obs_a).slice(0, 60),
      obs_b: String(r.obs_b).slice(0, 60),
      count: r.co_count as number,
      entities: [r.entity_a as string, r.entity_b as string] as [string, string]
    }));
  } catch { /* tables may not exist */ }

  // Store state in subconscious table
  const state = {
    processed_at: now.toISOString(),
    hot_entities: hotEntities,
    recurring_patterns: recurring,
    mood: { dominant: dominantEmotion, confidence: allEmotions.length > 5 ? "medium" : "low" },
    context_clusters: contextClusters,
    // Relation-based analysis
    central_nodes: centralNodes,
    relation_patterns: relationPatterns,
    relation_clusters: relationClusters.slice(0, 5),
    graph_stats: {
      total_relations: allRelations.results?.length || 0,
      unique_relation_types: Object.keys(relationTypeCounts).length,
      connected_entities: Object.keys(connectivity).length
    },
    // Living surface stats (field names match what orient expects)
    living_surface: {
      pending_proposals: pendingProposals,
      orphan_count: orphanCount,
      novelty_distribution: noveltyDist,
      strongest_co_surface: strongestCoSurface.slice(0, 3)
    }
  };

  // Upsert into subconscious table
  await env.DB.prepare(`
    INSERT INTO subconscious (id, state_type, data, updated_at)
    VALUES (1, 'daemon', ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
  `).bind(JSON.stringify(state), now.toISOString(), JSON.stringify(state), now.toISOString()).run();

  console.log(`Subconscious processed: ${hotEntities.length} hot entities, ${recurring.length} patterns, ${centralNodes.length} central nodes, ${relationClusters.length} relation clusters`);
}


// Auth - support both secret path AND header auth
// Secret is read from env.MIND_API_KEY (set via: wrangler secret put MIND_API_KEY)

function checkAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  const secret = env.MIND_API_KEY;
  if (!secret) return false;

  // Basic Auth (companion-mind:{MIND_API_KEY})
  if (authHeader.startsWith("Basic ")) {
    try {
      const base64 = authHeader.slice(6);
      const decoded = atob(base64);
      const [, headerSecret] = decoded.split(":");
      return headerSecret === secret;
    } catch { return false; }
  }

  // Bearer
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return token === secret;
  }

  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (public)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "ai-mind-cloud" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const secretPath = env.MIND_API_KEY ? `/mcp/${env.MIND_API_KEY}` : null;
    const isSecretPath = secretPath !== null && url.pathname === secretPath;
    const hasValidAuth = checkAuth(request, env);
    const isAuthorized = isSecretPath || hasValidAuth;

    // Image viewing with signed URL (no auth needed — signature IS the auth)
    if (url.pathname.startsWith("/img/") && env.R2_IMAGES) {
      const expires = url.searchParams.get("expires");
      const sig = url.searchParams.get("sig");
      const imgId = url.pathname.slice(5);
      if (!expires || !sig) return new Response("Missing signature", { status: 401 });
      if (parseInt(expires) < Math.floor(Date.now() / 1000)) return new Response("URL expired", { status: 403 });
      const encoder = new TextEncoder();
      const secret = env.SIGNING_SECRET || env.MIND_API_KEY;
      const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${imgId}:${expires}`));
      const expectedSig = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
      if (sig !== expectedSig) return new Response("Invalid signature", { status: 401 });
      const img = await env.DB.prepare("SELECT path FROM images WHERE id = ?").bind(imgId).first();
      if (!img?.path || !String(img.path).startsWith("r2://")) return new Response("Not found", { status: 404 });
      const r2Key = String(img.path).replace(/r2:\/\/[^/]+\//, "");
      const object = await env.R2_IMAGES.get(r2Key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType || "image/webp", "Cache-Control": "private, max-age=3600" } });
    }

    // Internal R2 serving (for WebP conversion pipeline)
    // _tmp_ keys are allowed without auth for cf.image transform (ephemeral, deleted after conversion)
    if (url.pathname.startsWith("/r2/") && env.R2_IMAGES) {
      const key = url.pathname.slice(4);
      if (!key.startsWith("_tmp_") && !isAuthorized) return new Response("Unauthorized", { status: 401 });
      const object = await env.R2_IMAGES.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType || "image/png" } });
    }

    // Subconscious processing trigger (auth required)
    if (url.pathname === "/process" && request.method === "POST") {
      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" }
        });
      }
      await processSubconscious(env);
      return new Response(JSON.stringify({ status: "processed" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get subconscious state (auth required)
    if (url.pathname === "/subconscious") {
      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { "Content-Type": "application/json" }
        });
      }
      const result = await env.DB.prepare(
        "SELECT data FROM subconscious WHERE state_type = 'daemon' ORDER BY updated_at DESC LIMIT 1"
      ).first();
      return new Response(JSON.stringify(result?.data ? JSON.parse(result.data as string) : {}), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // MCP endpoint - accept EITHER secret path OR auth header
    if ((url.pathname === "/mcp" || isSecretPath) && request.method === "POST") {
      if (!isAuthorized) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: 0,
          error: { code: -32600, message: "Unauthorized" }
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return handleMCPRequest(request, env);
    }

    return new Response("AI Mind Cloud", { headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processSubconscious(env));
  }
};
