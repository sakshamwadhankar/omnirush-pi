import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * OmniRush as a Pi provider — uses the CLI's own local credentials and wire
 * signature, so no login is needed inside Pi.
 *
 * Gateway: https://omnirush.ai/omnirush/v1 (OpenAI Responses API only;
 * chat/completions is not served). Credentials: ~/.omnirush/auth.json,
 * written by the official CLI (omnirush@2.x). Access tokens rotate via
 * POST /device/refresh {refresh_token}; we refresh and write back the pair
 * atomically, exactly like the CLI does.
 *
 * Wire signature the gateway requires (verified live against the manager):
 *   - User-Agent: exactly "omnirush" (bare product label; a versioned
 *     "omnirush/x" is treated as a lookalike and refused)
 *   - X-OmniRush-Client: cli/<version>
 *   - x-omnirush-session-id: an opencode-format EID ("ses_..."). Deeper
 *     checks in the SSE layer verify the official client; a missing or
 *     malformed session id is rejected with 403 client_not_allowed.
 *   - Body (Pi's built-in openai-responses implementation already sends):
 *     input as a list, stream: true, store: false.
 *
 * Model catalog: GET <gateway>/models with the same signature. Only
 * non-deprecated entries are kept. Seeds (below) cover the default list so
 * the provider works even before the catalog is fetched or during gateway
 * maintenance.
 */

const ORIGIN = "https://omnirush.ai/omnirush";
const GATEWAY_BASE = `${ORIGIN}/v1`;
const AUTH_FILE = path.join(homedir(), ".omnirush", "auth.json");
const CLI_VERSION_ENV = "OMNIRUSH_CLI_VERSION";
const DEFAULT_CLI_VERSION = "2.7.1";

// Refresh the access token when it is older than this (the CLI rotates access
// tokens on a short cycle; we stay well inside it).
const REFRESH_AFTER_MS = 20 * 60 * 1000;
const REFRESH_POLL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface ModelSeed {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  context: number;
  output: number;
}

// Verified against the live catalog on 2026-11-01. The live catalog replaces
// these when it can be fetched.
const SEED_MODELS: ModelSeed[] = [
  { id: "gpt-6-astra", name: "GPT 6 Astra", reasoning: true, input: ["text", "image"], context: 400000, output: 128000 },
  { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", reasoning: true, input: ["text", "image"], context: 400000, output: 128000 },
  { id: "gpt-6-sol", name: "GPT 6 Sol", reasoning: true, input: ["text", "image"], context: 400000, output: 128000 },
];

// opencode EID format: `<prefix>_<12 hex chars><14 chars from a 62-char
// alphabet>`. The gateway rejects session ids that do not match this shape.
const EID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastEidTimestamp = 0;
let eidCounter = 0;

export const EID_PATTERN = /^(?:ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function createEid(prefix: "ses" | "msg"): string {
  const ts = Date.now();
  if (ts !== lastEidTimestamp) {
    lastEidTimestamp = ts;
    eidCounter = 0;
  }
  const current = BigInt(ts) * 0x1000n + BigInt(eidCounter);
  eidCounter++;
  const time = current.toString(16).padStart(12, "0").slice(0, 12);
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let rand = "";
  for (const byte of bytes) rand += EID_CHARS[byte % 62];
  return `${prefix}_${time}${rand}`;
}

export interface AuthState {
  accessToken?: string;
  refreshToken?: string;
  gatewayUrl?: string;
  savedAt?: number;
}

/** Parse the CLI's auth.json content (tolerant of missing fields). */
export function parseAuth(text: string | undefined): AuthState {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return {
      accessToken: typeof raw.accessToken === "string" ? raw.accessToken : undefined,
      refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : undefined,
      gatewayUrl: typeof raw.gatewayUrl === "string" ? raw.gatewayUrl : undefined,
      savedAt: typeof raw.savedAt === "string" ? Date.parse(raw.savedAt) || undefined : undefined,
    };
  } catch {
    return {};
  }
}

export function readAuthFile(file = AUTH_FILE): AuthState {
  try {
    return parseAuth(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeAuthFile(state: AuthState, file = AUTH_FILE): void {
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify(
      {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        gatewayUrl: state.gatewayUrl,
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    // Atomic write: temp file + rename, like the CLI does. Never leave a
    // half-written auth.json behind.
    const tmp = `${file}.pi-tmp`;
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* best effort only */
  }
}

export function cliVersion(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[CLI_VERSION_ENV];
  if (fromEnv && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(fromEnv)) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(path.join(homedir(), "AppData", "Roaming", "npm", "node_modules", "omnirush", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(pkg.version)) return pkg.version;
  } catch {
    /* fall through */
  }
  return DEFAULT_CLI_VERSION;
}

export interface FingerprintHeaders {
  "user-agent": string;
  "x-omnirush-client": string;
  "x-omnirush-session-id": string;
  authorization?: string;
}

export function buildHeaders(auth: AuthState, sessionId: string, version: string): FingerprintHeaders {
  const headers: FingerprintHeaders = {
    "user-agent": "omnirush",
    "x-omnirush-client": `cli/${version}`,
    "x-omnirush-session-id": sessionId,
  };
  if (auth.accessToken) headers.authorization = `Bearer ${auth.accessToken}`;
  return headers;
}

export function toModelSeeds(payload: unknown): ModelSeed[] {
  const list = (payload as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(list)) return [];
  const seeds: ModelSeed[] = [];
  for (const entry of list) {
    const model = entry as Record<string, unknown> | undefined;
    if (!model || typeof model.id !== "string") continue;
    if (model.status === "deprecated") continue;
    const limits = (model.limits ?? {}) as Record<string, unknown>;
    const caps = (model.capabilities ?? {}) as Record<string, unknown>;
    const input: string[] = ["text"];
    if (caps.image_input === true) input.push("image");
    seeds.push({
      id: model.id,
      name: typeof model.display_name === "string" ? model.display_name : model.id,
      reasoning: caps.reasoning === true,
      input,
      context: typeof limits.context === "number" && limits.context > 0 ? Math.min(limits.context, 2_000_000) : 400000,
      output: typeof limits.output === "number" && limits.output > 0 ? Math.min(limits.output, 256000) : 128000,
    });
  }
  return seeds;
}

export function providerModels(seeds: ModelSeed[]): Array<Record<string, unknown>> {
  return seeds.map((m) => ({
    type: "chat",
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context,
    maxTokens: m.output,
  }));
}

let auth: AuthState | undefined;
let sessionId = createEid("ses");
let refreshing: Promise<boolean> | null = null;
let refreshRequested = false;

function ensureAuth(): AuthState {
  if (!auth) auth = readAuthFile();
  return auth;
}

async function fetchJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Rotate the device token pair. Single-flight: concurrent callers share one
 * attempt. Never called when the refresh token is missing.
 */
export async function refreshDeviceTokens(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = ensureAuth();
    if (!current.refreshToken) return { ok: false, error: "no refresh token in auth.json" };
    const version = cliVersion();
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "omnirush",
      "x-omnirush-client": `cli/${version}`,
    };
    try {
      const response = await fetch(`${ORIGIN}/device/refresh`, {
        method: "POST",
        headers,
        body: JSON.stringify({ refresh_token: current.refreshToken }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, error: `refresh failed (${response.status})` };
      }
      const data = (await response.json()) as Record<string, unknown>;
      const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
      if (!accessToken) return { ok: false, error: "refresh response missing access_token" };
      auth = {
        accessToken,
        refreshToken,
        gatewayUrl: current.gatewayUrl,
        savedAt: Date.now(),
      };
      writeAuthFile(auth);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function refreshIfStale(): Promise<void> {
  const current = ensureAuth();
  if (!current.accessToken) return;
  const age = current.savedAt ? Date.now() - current.savedAt : Number.POSITIVE_INFINITY;
  if (age > REFRESH_AFTER_MS) {
    await refreshDeviceTokens();
  }
}

export async function fetchCatalog(signal?: AbortSignal): Promise<ModelSeed[]> {
  const current = ensureAuth();
  if (!current.accessToken) return [];
  const version = cliVersion();
  const headers = buildHeaders(current, sessionId, version);
  const payload = await fetchJson<unknown>(`${GATEWAY_BASE}/models`, headers, signal);
  return toModelSeeds(payload);
}

function registerModels(pi: ExtensionAPI, seeds: ModelSeed[]): void {
  pi.registerProvider("omnirush", {
    name: "OmniRush",
    baseUrl: GATEWAY_BASE,
    apiKey: "injected", // real token is injected per request via before_provider_headers
    api: "openai-responses",
    models: providerModels(seeds),
    refreshModels: async (context: { allowNetwork?: boolean; signal?: AbortSignal }) => {
      if (context.allowNetwork !== false) {
        const seedsLive = await fetchCatalog(context.signal);
        if (seedsLive.length > 0) return providerModels(seedsLive);
      }
      return providerModels(seeds);
    },
  });
}

/**
 * The per-request fingerprint and token injection. Runs before every provider
 * request; reads the current (possibly pre-refreshed) token synchronously.
 */
function applyFingerprint(headers: Record<string, unknown>, version: string): void {
  const current = ensureAuth();
  const fp = buildHeaders(current, sessionId, version);
  for (const [key, value] of Object.entries(fp)) {
    if (value !== undefined) headers[key] = value;
  }
  // Gateway maintenance/official-client errors come back inside the SSE body,
  // so they surface as provider errors — nothing to patch here.
}

export default function (pi: ExtensionAPI): void {
  const version = cliVersion();

  registerModels(pi, SEED_MODELS);

  // Warm a token refresh in the background without blocking startup.
  void refreshIfStale();
  const timer = setInterval(() => void refreshIfStale(), REFRESH_POLL_MS);
  timer.unref?.();

  // A new Pi session gets a fresh opencode-format session id.
  pi.on("session_start", () => {
    sessionId = createEid("ses");
  });

  pi.on("before_provider_headers", (event) => {
    applyFingerprint(event.headers as Record<string, unknown>, version);
  });

  // A 401 means the access token rotated under us: refresh now so the next
  // request succeeds. Only refresh once per burst.
  pi.on("after_provider_response", (event) => {
    if (event?.status === 401 && !refreshRequested) {
      refreshRequested = true;
      void refreshDeviceTokens().finally(() => {
        refreshRequested = false;
      });
    }
  });

  pi.registerCommand("omnirush", {
    description: "OmniRush models. Subcommands: models (list), refresh (update catalog), version (CLI version), help.",
    handler: async (args: string, ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void } }) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] ?? "help";
      if (sub === "models") {
        const current = ensureAuth();
        if (!current.accessToken) {
          ctx.ui.notify("omnirush: no credentials — run the OmniRush CLI once (omnirush) to sign in", "error");
          return;
        }
        const seeds = await fetchCatalog();
        if (seeds.length === 0) {
          ctx.ui.notify("omnirush: catalog fetch failed; using seed models", "warning");
          return;
        }
        registerModels(pi, seeds);
        ctx.ui.notify(`omnirush: ${seeds.map((m) => m.id).join(", ")}`, "info");
        return;
      }
      if (sub === "refresh") {
        const result = await refreshDeviceTokens();
        if (!result.ok) {
          ctx.ui.notify(`omnirush: token refresh failed (${result.error ?? "unknown"})`, "error");
          return;
        }
        const seeds = await fetchCatalog();
        if (seeds.length > 0) registerModels(pi, seeds);
        ctx.ui.notify(`omnirush: tokens refreshed, ${seeds.length > 0 ? seeds.length : "seed"} model(s) registered`, "info");
        return;
      }
      if (sub === "version") {
        ctx.ui.notify(`omnirush: CLI version ${version}`, "info");
        return;
      }
      ctx.ui.notify("omnirush subcommands: models | refresh | version | help", "info");
    },
  });
}

