// OpenCode Jev — typed decision provider for OpenClaw's decisionModel role.
//
// This file is intentionally dependency-free and build-free. The plugin entry is
// a plain object accepted by OpenClaw's plugin loader; only the optional secret
// runtime import is lazy so `node --test` can load this module without OpenClaw.
//
// Protocol: POST https://opencode.ai/inference/systemone/v1/systemone
//   boolean -> noul, choice -> choice, score -> score
//
// Design constraints:
//   * fixed HTTPS endpoint, never configurable (no SSRF surface)
//   * no Authorization header for any model whose id ends with "-free"
//   * one bounded request per evaluate, no retries
//   * no evidence, questions, answers, or credentials in logs
//   * every downstream failure maps to a typed unavailable reason; caller
//     cancellation rejects instead of becoming unavailable

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

export const PLUGIN_ID = "opencode-jev";
export const PLUGIN_NAME = "OpenCode Jev";
export const PLUGIN_DESCRIPTION =
  "Typed decision provider for OpenCode Jev models.";
export const PLUGIN_VERSION = "0.1.0";
export const ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";
export const DEFAULT_KEY_FILE = join(
  homedir(),
  ".openclaw",
  ".secrets",
  "opencode-jev.key",
);
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 25_000;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_QUESTIONS = 256;
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

const USER_AGENT = `${PLUGIN_ID}/${PLUGIN_VERSION}`;
const FREE_SUFFIX = "-free";

/** Config schema shared with openclaw.plugin.json; a test keeps both copies identical. */
export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    apiKey: {
      description: "OpenCode API key or SecretRef. Optional for jev-1.13-free.",
      anyOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "provider", "id"],
          properties: {
            source: { type: "string", enum: ["env", "store", "file", "exec"] },
            provider: { type: "string", minLength: 1, maxLength: 128 },
            id: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      ],
    },
    keyFile: {
      type: "string",
      minLength: 1,
      description: "Path to a 0600 file containing the OpenCode API key.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 30000,
      default: 25000,
    },
  },
};

/** Typed downstream failure; maps onto the version 1 provider failure reasons. */
class Unavailable extends Error {
  constructor(reason, retryAfterMs) {
    super(`${PLUGIN_ID}: ${reason}`);
    this.name = "UnavailableDecision";
    this.reason = reason;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      this.retryAfterMs = Math.max(0, Math.round(retryAfterMs));
    }
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function normalizeConfig(raw) {
  const config = isRecord(raw) ? raw : {};
  const keyFile =
    typeof config.keyFile === "string" && config.keyFile.trim()
      ? expandHome(config.keyFile.trim())
      : DEFAULT_KEY_FILE;
  const configuredTimeout =
    typeof config.timeoutMs === "number" &&
    Number.isFinite(config.timeoutMs) &&
    config.timeoutMs > 0
      ? Math.floor(config.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, configuredTimeout));
  return { apiKey: config.apiKey, keyFile, timeoutMs };
}

/** Model references may arrive as "provider/model"; only the tail is sent to OpenCode. */
export function modelFromContext(context) {
  const raw = typeof context?.model === "string" ? context.model.trim() : "";
  if (!raw) return "";
  const slash = raw.lastIndexOf("/");
  return (slash >= 0 ? raw.slice(slash + 1) : raw).trim();
}

export function isFreeModel(model) {
  return typeof model === "string" && model.endsWith(FREE_SUFFIX);
}

/** Preserve strings, objects, arrays, and null; stringify only top-level numbers and booleans. */
function wireValue(value) {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return value;
}

function supportedEntry(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    isRecord(value)
  );
}

/**
 * OpenClaw decision batch -> System One request payload.
 * Returns { ok: true, payload } or { ok: false, reason } and never includes
 * question content in an error.
 */
export function buildRequest(model, batch) {
  if (typeof model !== "string" || !model.trim())
    return { ok: false, reason: "unsupported-input" };
  if (!isRecord(batch) || !isRecord(batch.questions))
    return { ok: false, reason: "unsupported-input" };

  const entries = Object.entries(batch.questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS)
    return { ok: false, reason: "unsupported-input" };

  const questions = [];
  for (const [id, question] of entries) {
    if (!id || !isRecord(question))
      return { ok: false, reason: "unsupported-input" };

    const instructions =
      question.instructions === undefined
        ? undefined
        : wireValue(question.instructions);
    const instructionsField =
      instructions === undefined || !supportedEntry(instructions)
        ? {}
        : { instructions };

    if (question.type === "choice") {
      if (!isRecord(question.criteria))
        return { ok: false, reason: "unsupported-input" };
      const criteriaEntries = Object.entries(question.criteria);
      if (
        criteriaEntries.length < 2 ||
        criteriaEntries.length > MAX_CHOICE_OPTIONS
      ) {
        return { ok: false, reason: "unsupported-input" };
      }
      const criteria = criteriaEntries.map(([label, description]) => {
        if (!label) return null;
        const value = description === undefined ? "" : wireValue(description);
        if (!supportedEntry(value)) return null;
        return [String(label), value];
      });
      if (criteria.some((entry) => entry === null))
        return { ok: false, reason: "unsupported-input" };
      questions.push([
        id,
        {
          type: "choice",
          ...instructionsField,
          criteria: Object.fromEntries(criteria),
        },
      ]);
      continue;
    }

    if (question.type === "score") {
      if (!Array.isArray(question.criteria))
        return { ok: false, reason: "unsupported-input" };
      if (
        question.criteria.length < 2 ||
        question.criteria.length > MAX_SCORE_LEVELS
      ) {
        return { ok: false, reason: "unsupported-input" };
      }
      const criteria = question.criteria.map((level) => {
        const value = level === undefined ? "" : wireValue(level);
        return supportedEntry(value) ? value : undefined;
      });
      if (criteria.some((entry) => entry === undefined))
        return { ok: false, reason: "unsupported-input" };
      questions.push([id, { type: "score", ...instructionsField, criteria }]);
      continue;
    }

    if (question.type === "boolean") {
      const wireQuestion = { type: "noul", ...instructionsField };
      if (question.criteria !== undefined && question.criteria !== null) {
        if (!isRecord(question.criteria))
          return { ok: false, reason: "unsupported-input" };
        const criteria = [];
        for (const key of ["true", "false"]) {
          if (!Object.hasOwn(question.criteria, key)) continue;
          const value = question.criteria[key];
          if (value === undefined) continue;
          const wire = wireValue(value);
          if (!supportedEntry(wire))
            return { ok: false, reason: "unsupported-input" };
          criteria.push([key, wire]);
        }
        if (criteria.length > 0)
          wireQuestion.criteria = Object.fromEntries(criteria);
      }
      questions.push([id, wireQuestion]);
      continue;
    }

    return { ok: false, reason: "unsupported-input" };
  }

  const state = batch.state === undefined ? "" : batch.state;
  return {
    ok: true,
    payload: {
      model: model.trim(),
      state,
      questions: Object.fromEntries(questions),
    },
  };
}

function clampProbability(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function hasMass(values) {
  return values.some((value) => value > 0);
}

function readUsage(raw) {
  if (!isRecord(raw)) return undefined;
  const usage = {};
  for (const [wire, key] of [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
  ]) {
    const value = raw[wire];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * System One response -> validated OpenClaw result.
 * Extra fields are ignored; missing or malformed required fields are rejected.
 */
export function normalizeResponse(batch, raw) {
  if (
    !isRecord(raw) ||
    typeof raw.model !== "string" ||
    !raw.model.trim() ||
    raw.model.length > 256
  ) {
    return { ok: false, reason: "invalid-response" };
  }
  if (!isRecord(raw.answers) || !isRecord(batch?.questions)) {
    return { ok: false, reason: "invalid-response" };
  }

  const answers = [];
  for (const [id, question] of Object.entries(batch.questions)) {
    if (!isRecord(question) || !Object.hasOwn(raw.answers, id)) {
      return { ok: false, reason: "invalid-response" };
    }
    const answer = raw.answers[id];
    if (!isRecord(answer)) return { ok: false, reason: "invalid-response" };

    if (question.type === "boolean") {
      if (answer.type !== "noul")
        return { ok: false, reason: "invalid-response" };
      const probabilityTrue = clampProbability(answer.noul);
      if (probabilityTrue === undefined)
        return { ok: false, reason: "invalid-response" };
      answers.push([id, { type: "boolean", probabilityTrue }]);
      continue;
    }

    if (question.type === "choice") {
      if (answer.type !== "choice" || !isRecord(question.criteria)) {
        return { ok: false, reason: "invalid-response" };
      }
      if (typeof answer.choice !== "string" || !answer.choice) {
        return { ok: false, reason: "invalid-response" };
      }
      const labels = Object.keys(question.criteria);
      if (
        labels.length < 2 ||
        !Object.hasOwn(question.criteria, answer.choice)
      ) {
        return { ok: false, reason: "invalid-response" };
      }
      if (!isRecord(answer.probabilities))
        return { ok: false, reason: "invalid-response" };
      const probabilities = labels.map((label) => {
        const value = Object.hasOwn(answer.probabilities, label)
          ? answer.probabilities[label]
          : undefined;
        return clampProbability(value) ?? 0;
      });
      if (!hasMass(probabilities)) {
        const chosen = labels.indexOf(answer.choice);
        probabilities[chosen] = 1;
      }
      const entry = {
        type: "choice",
        choice: answer.choice,
        probabilities: Object.fromEntries(
          labels.map((label, index) => [label, probabilities[index]]),
        ),
      };
      const confidence = clampProbability(answer.confidence);
      if (confidence !== undefined) entry.confidence = confidence;
      answers.push([id, entry]);
      continue;
    }

    if (question.type === "score") {
      if (answer.type !== "score" || !Array.isArray(question.criteria)) {
        return { ok: false, reason: "invalid-response" };
      }
      const levels = question.criteria.length;
      if (levels < 2) return { ok: false, reason: "invalid-response" };
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
        return { ok: false, reason: "invalid-response" };
      }
      const score = Math.min(levels - 1, Math.max(0, answer.score));
      let probabilities;
      if (Array.isArray(answer.probabilities)) {
        probabilities = Array.from({ length: levels }, (_, index) => {
          return clampProbability(answer.probabilities[index]) ?? 0;
        });
      } else if (isRecord(answer.probabilities)) {
        probabilities = Array.from({ length: levels }, (_, index) => {
          const key = String(index);
          const value = Object.hasOwn(answer.probabilities, key)
            ? answer.probabilities[key]
            : undefined;
          return clampProbability(value) ?? 0;
        });
      } else {
        return { ok: false, reason: "invalid-response" };
      }
      if (!hasMass(probabilities)) {
        const index = Math.min(levels - 1, Math.max(0, Math.round(score)));
        probabilities[index] = 1;
      }
      const entry = { type: "score", score, probabilities };
      const confidence = clampProbability(answer.confidence);
      if (confidence !== undefined) entry.confidence = confidence;
      answers.push([id, entry]);
      continue;
    }

    return { ok: false, reason: "invalid-response" };
  }

  const usage = readUsage(raw.usage);
  return {
    ok: true,
    result: {
      model: raw.model.trim(),
      answers: Object.fromEntries(answers),
      ...(usage ? { usage } : {}),
    },
  };
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) throw abortReason(signal);
}

function parseRetryAfterMs(headers) {
  const milliseconds = headers?.get?.("retry-after-ms");
  if (typeof milliseconds === "string" && milliseconds.trim()) {
    const value = Number(milliseconds.trim());
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const seconds = headers?.get?.("retry-after");
  if (typeof seconds === "string" && seconds.trim()) {
    const value = Number(seconds.trim());
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  }
  return undefined;
}

function httpFailure(response) {
  if (response.status === 401 || response.status === 403)
    return new Unavailable("authentication");
  if (response.status === 429)
    return new Unavailable("rate-limited", parseRetryAfterMs(response.headers));
  if (
    response.status === 400 ||
    response.status === 413 ||
    response.status === 422
  ) {
    return new Unavailable("unsupported-input");
  }
  return new Unavailable("transport");
}

function decodeJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function readResponseBody(response, timeoutSignal, outerSignal) {
  if (outerSignal?.aborted) throw abortReason(outerSignal);
  if (timeoutSignal?.aborted) throw abortReason(timeoutSignal);

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks = [];
  let length = 0;
  let cancellation;
  const cancel = () => {
    cancellation ??= Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => {});
  };
  timeoutSignal?.addEventListener("abort", cancel, { once: true });

  try {
    while (true) {
      if (outerSignal?.aborted) throw abortReason(outerSignal);
      const { done, value } = await reader.read();
      if (outerSignal?.aborted) throw abortReason(outerSignal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        cancel();
        throw new Unavailable("invalid-response");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    timeoutSignal?.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
}

async function callEndpoint({ payload, apiKey, timeoutMs, signal, fetchImpl }) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new Unavailable("unsupported-input");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Unavailable("unsupported-input");
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(abortReason(signal));
  if (signal) {
    if (signal.aborted) throw abortReason(signal);
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new Error("opencode-jev timeout"));
    },
    Math.max(1, timeoutMs),
  );

  try {
    const headers = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error instanceof Unavailable) throw error;
      throw new Unavailable("transport");
    }

    if (!response || typeof response.status !== "number")
      throw new Unavailable("transport");
    if (signal?.aborted) throw abortReason(signal);
    if (timedOut) throw new Unavailable("transport");

    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch {
        /* the status mapping is the useful outcome */
      }
      throw httpFailure(response);
    }

    const contentLength = response.headers?.get?.("content-length");
    if (typeof contentLength === "string" && contentLength.trim()) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        try {
          await response.body?.cancel?.();
        } catch {
          /* nothing else to release */
        }
        throw new Unavailable("invalid-response");
      }
    }

    let bytes;
    try {
      bytes = await readResponseBody(response, controller.signal, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) throw new Unavailable("transport");
      throw error;
    }

    if (signal?.aborted) throw abortReason(signal);
    if (timedOut) throw new Unavailable("transport");
    const decoded = decodeJson(bytes);
    if (!decoded.ok) throw new Unavailable("invalid-response");
    return decoded.value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Read a key file only when it is a regular, non-empty file with no group/world permissions. */
export async function readKeyFile(path) {
  if (typeof path !== "string" || !path) return undefined;
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if ((info.mode & 0o077) !== 0) return undefined;
    const raw = await readFile(path, "utf8");
    const value = raw.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function resolveConfiguredApiKey(config) {
  const configured = config?.apiKey;
  if (typeof configured === "string") {
    const value = configured.trim();
    if (value) return value;
  } else if (isRecord(configured)) {
    try {
      const mod = await import("openclaw/plugin-sdk/secret-input-runtime");
      const value = mod?.getPreparedPluginSecretInput?.(
        PLUGIN_ID,
        "apiKey",
      )?.value;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      /* the host helper is optional; keyFile remains available */
    }
  }
  return readKeyFile(config?.keyFile);
}

/**
 * Build a version 1 decision provider.
 * Tests inject fetchImpl and resolveApiKey; production uses the default resolver.
 */
export function createDecisionProvider(options = {}) {
  const config = normalizeConfig(options.config);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolveApiKey =
    typeof options.resolveApiKey === "function"
      ? options.resolveApiKey
      : () => resolveConfiguredApiKey(config);

  if (typeof fetchImpl !== "function")
    throw new Error("opencode-jev: fetch is unavailable");

  return {
    id: PLUGIN_ID,
    contractVersion: 1,
    isReady: () => true,

    async evaluate(batch, context) {
      const signal = context?.signal;
      throwIfAborted(signal);

      const model = modelFromContext(context);
      if (!model) return { status: "unavailable", reason: "unsupported-input" };

      const built = buildRequest(model, batch);
      if (!built.ok) return { status: "unavailable", reason: built.reason };

      try {
        let apiKey;
        if (!isFreeModel(model)) {
          try {
            apiKey = await resolveApiKey();
          } catch {
            throwIfAborted(signal);
            return { status: "unavailable", reason: "credentials-unavailable" };
          }
          throwIfAborted(signal);
          if (typeof apiKey !== "string" || !apiKey.trim()) {
            return { status: "unavailable", reason: "credentials-unavailable" };
          }
          apiKey = apiKey.trim();
        }

        const deadline = context?.deadlineMonotonicMs;
        const remaining =
          typeof deadline === "number" && Number.isFinite(deadline)
            ? deadline - performance.now()
            : Number.POSITIVE_INFINITY;
        if (remaining <= 0)
          return { status: "unavailable", reason: "transport" };

        const timeoutMs = Math.max(1, Math.min(config.timeoutMs, remaining));
        const payload = await callEndpoint({
          payload: built.payload,
          apiKey,
          timeoutMs,
          signal,
          fetchImpl,
        });
        throwIfAborted(signal);

        const normalized = normalizeResponse(batch, payload);
        if (!normalized.ok)
          return { status: "unavailable", reason: normalized.reason };
        return { status: "ok", result: normalized.result };
      } catch (error) {
        // Caller cancellation (including the host deadline signal) must reject.
        throwIfAborted(signal);
        if (error instanceof Unavailable) {
          const outcome = { status: "unavailable", reason: error.reason };
          if (error.retryAfterMs !== undefined)
            outcome.retryAfterMs = error.retryAfterMs;
          return outcome;
        }
        return { status: "unavailable", reason: "transport" };
      }
    },
  };
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: { jsonSchema: CONFIG_SCHEMA },
  register(api) {
    const provider = createDecisionProvider({ config: api?.pluginConfig });
    api.registerDecisionProvider(provider);
  },
};

// OpenClaw 2026.11.4's `plugins validate` command inspects tool/feature
// authoring metadata before it checks the manifest. A decision provider has no
// tools, so expose an empty non-enumerable metadata record for that validator.
// Runtime loading ignores this symbol; no tool is registered.
Object.defineProperty(
  plugin,
  Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata"),
  {
    value: {
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      description: PLUGIN_DESCRIPTION,
      activation: { onStartup: true },
      configSchema: CONFIG_SCHEMA,
      tools: [],
    },
    enumerable: false,
  },
);

export default plugin;
