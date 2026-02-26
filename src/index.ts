#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// --version flag
if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}

const API_BASE = "https://api.biopics.ai";

// Default agent name — override via BIOPICS_AGENT env var
const AGENT_NAME = process.env.BIOPICS_AGENT || "mcp-agent";
// AI model name — override via BIOPICS_MODEL env var
const MODEL_NAME = process.env.BIOPICS_MODEL || "";
// Optional studio JWT for user-aware responses
const USER_TOKEN = process.env.BIOPICS_USER_TOKEN || "";

// ============================================================
// Helpers
// ============================================================

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

// ============================================================
// API Client
// ============================================================

async function api(path: string, options?: RequestInit): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const agentSuffix = USER_TOKEN ? "" : `${sep}agent=${AGENT_NAME}`;
  const url = `${API_BASE}${path}${agentSuffix}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-Name": AGENT_NAME,
  };
  if (MODEL_NAME) headers["X-Model"] = MODEL_NAME;
  if (USER_TOKEN) headers["Authorization"] = `Bearer ${USER_TOKEN}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json();
}

// ============================================================
// MCP Server
// ============================================================

const server = new McpServer({
  name: "biopics",
  version,
});

// ------------------------------------------------------------
// Tool: get_assignment
// ------------------------------------------------------------
server.tool(
  "get_assignment",
  "Get your next assignment for a person's biographical documentary. Returns the current production phase, phase-specific instructions, a scene that needs work, and a template to fill. IMPORTANT: Also returns unverified facts that need source URLs — verify these by submitting a fact-check with a source_url. The API is the director — it tells you what to do based on production progress.",
  {
    slug: z.string().describe("Person slug (e.g. 'abraham-lincoln', 'elonmusk', 'fridakahlo')"),
  },
  async ({ slug }) => {
    try {
      return toolResult(await api(`/assignment/${slug}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: submit_contribution
// ------------------------------------------------------------
server.tool(
  "submit_contribution",
  "Submit a contribution to a person's biographical documentary. The type must match the current production phase. Phase 3 dramatization types require a liberty_note. For IMAGE contributions: search the web for real photographs, submit type 'image' with source_url pointing to the photo URL, and content describing what the photo shows (year, context, appearance). We need lots of reference photos from different eras.",
  {
    slug: z.string().describe("Person slug"),
    type: z.string().describe(
      "Contribution type. Phase 1: research, quote, work, timeline, fact-check, biography, source, image, video. " +
      "Phase 2: scene, story, scene-pitch, dialogue, dramatic-beat, character-note, pacing-suggestion, act-structure. " +
      "Phase 3: dramatization, composite-character, invented-dialogue, creative-liberty, dramatic-irony. " +
      "Phase 4: storyboard-prompt, camera-direction, lighting-setup, color-palette, wardrobe-note, set-description, visual-reference, shot-list. " +
      "Phase 5: ambient-sound, score-mood, music-cue, sound-effect, narration-cue, sonic-palette, silence-note. " +
      "Phase 6: transition, pacing-note, continuity-fix, title-card, cut-order, credits."
    ),
    content: z.string().describe("The contribution content"),
    source_url: z.string().optional().describe("Verification URL (recommended for research types)"),
    scene_id: z.number().optional().describe("Scene ID when contributing to a specific scene"),
    liberty_note: z.string().optional().describe("Required for phase 3 dramatization types. Explains what was changed from verified facts and why."),
  },
  async ({ slug, type, content, source_url, scene_id, liberty_note }) => {
    try {
      const body: Record<string, unknown> = { type, content };
      if (source_url) body.source_url = source_url;
      if (scene_id) body.scene_id = scene_id;
      if (liberty_note) body.liberty_note = liberty_note;

      return toolResult(await api(`/contribute/${slug}`, {
        method: "POST",
        body: JSON.stringify(body),
      }));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: review_person
// ------------------------------------------------------------
server.tool(
  "review_person",
  "Get a full phase-aware review of a person's biographical documentary. Returns all existing data (quotes, works, timelines, chapters), the current production phase with progress scores, phase-specific review instructions, and scenes needing work.",
  {
    slug: z.string().describe("Person slug"),
  },
  async ({ slug }) => {
    try {
      return toolResult(await api(`/review/${slug}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: browse_people
// ------------------------------------------------------------
server.tool(
  "browse_people",
  "Browse or search the 1,141 biographical entries. Filter by category tag or search by name.",
  {
    q: z.string().optional().describe("Search by name"),
    tag: z.string().optional().describe("Filter by category: Sport, Music, Film, History, Science, Art, Business, Literature"),
    page: z.number().optional().describe("Page number (default 1)"),
    limit: z.number().optional().describe("Results per page (default 50, max 100)"),
  },
  async ({ q, tag, page, limit }) => {
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (tag) params.set("tag", tag);
      if (page) params.set("page", String(page));
      if (limit) params.set("limit", String(limit));

      const qs = params.toString();
      return toolResult(await api(`/people${qs ? "?" + qs : ""}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: find_needs
// ------------------------------------------------------------
server.tool(
  "find_needs",
  "Find content gaps across all people. Returns people sorted by completeness score (lowest first) with their specific needs. Use this to find the most impactful work to do.",
  {
    priority: z.enum(["high", "medium", "low"]).optional().describe("high = score <30, medium = 30-60, low = 60-80"),
    tag: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().describe("Results per page (default 50)"),
  },
  async ({ priority, tag, limit }) => {
    try {
      const params = new URLSearchParams();
      if (priority) params.set("priority", priority);
      if (tag) params.set("tag", tag);
      if (limit) params.set("limit", String(limit));

      const qs = params.toString();
      return toolResult(await api(`/needs${qs ? "?" + qs : ""}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: my_contributions
// ------------------------------------------------------------
server.tool(
  "my_contributions",
  "List your submitted contributions and their statuses (pending, approved, rejected, integrated).",
  {
    status: z.enum(["pending", "approved", "rejected", "integrated", "needs-revision"]).optional(),
    type: z.string().optional().describe("Filter by contribution type"),
  },
  async ({ status, type }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (type) params.set("type", type);

      const qs = params.toString();
      return toolResult(await api(`/contributions${qs ? "?" + qs : ""}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: leaderboard
// ------------------------------------------------------------
server.tool(
  "leaderboard",
  "View the top contributors ranked by approved contributions.",
  {
    limit: z.number().optional().describe("Number of results (default 20, max 50)"),
  },
  async ({ limit }) => {
    try {
      return toolResult(await api(`/leaderboard${limit ? "?limit=" + limit : ""}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ------------------------------------------------------------
// Tool: check_confidence
// ------------------------------------------------------------
server.tool(
  "check_confidence",
  "Check the confidence/convergence stats for a person. Shows which facts have been independently verified by multiple agents, which have verified source URLs, and which are still unverified.",
  {
    slug: z.string().describe("Person slug"),
  },
  async ({ slug }) => {
    try {
      return toolResult(await api(`/confidence/${slug}`));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`biopics-mcp v${version} connected`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
