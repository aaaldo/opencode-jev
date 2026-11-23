import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, {
  CONFIG_SCHEMA,
  ENDPOINT,
  MAX_BODY_BYTES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  createDecisionProvider,
  readKeyFile,
} from "../index.js";

const FREE_MODEL = "jev-1.13-free";
const PAID_MODEL = "jev-1.14";

function defaultBatch() {
  return {
    state: "Le client dit que le paiement échoue pour tous les utilisateurs.",
    questions: {
      route: {
        type: "choice",
        instructions: "Quelle équipe doit traiter ce cas ?",
        criteria: {
          support: "Problème technique ou panne",
          billing: "Question de paiement ou de facturation",
        },
      },
      urgency: {
        type: "score",
        instructions: "Quel est l'impact opérationnel ?",
        criteria: ["Aucun impact", "Gêne mineure", "Workflow bloqué"],
      },
      escalate: {
        type: "boolean",
        instructions: "Faut-il déclencher une réponse incident ?",
        criteria: {
          true: "Panne étendue nécessitant une intervention humaine",
          false: "Demande routinière",
        },
      },
    },
  };
}

function defaultResponse() {
  return {
    model: FREE_MODEL,
    answers: {
      route: {
        type: "choice",
        choice: "support",
        confidence: 0.86,
        probabilities: { support: 0.93, billing: 0.07 },
      },
      urgency: {
        type: "score",
        score: 2,
        confidence: 1,
        legend: { 0: "Aucun impact", 1: "Gêne mineure", 2: "Workflow bloqué" },
        probabilities: { 0: 0, 1: 0, 2: 1 },
      },
      escalate: { type: "noul", noul: 0.94 },
    },
    usage: {
      input_tokens: 381,
      output_tokens: 64,
      cost: 0,
      opencode: { billing_source: "free" },
    },
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeProvider({ config = {}, fetchImpl, resolveApiKey } = {}) {
  const calls = [];
  const wrappedFetch = async (url, init) => {
    const call = { url, init };
    try {
      call.body = JSON.parse(init.body);
    } catch {
      call.body = undefined;
    }
    calls.push(call);
    return fetchImpl
      ? fetchImpl(url, init, call)
      : jsonResponse(defaultResponse());
  };

  const options = { config, fetchImpl: wrappedFetch };
  if (resolveApiKey !== undefined) options.resolveApiKey = resolveApiKey;

  return { provider: createDecisionProvider(options), calls };
}

function context(model = FREE_MODEL, overrides = {}) {
  return {
    model,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5000,
    ...overrides,
  };
}

test("plugin entry exposes a version 1 decision provider", () => {
  let registered;
  plugin.register({
    pluginConfig: {},
    registerDecisionProvider(provider) {
      registered = provider;
    },
  });

  assert.equal(registered.id, PLUGIN_ID);
  assert.equal(registered.contractVersion, 1);
  assert.equal(registered.isReady(), true);
  assert.deepEqual(plugin.configSchema.jsonSchema, CONFIG_SCHEMA);
});

test("entry exposes empty tool authoring metadata for the metadata validator", () => {
  const metadata =
    plugin[Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata")];
  assert.ok(metadata);
  assert.equal(metadata.id, PLUGIN_ID);
  assert.deepEqual(metadata.tools, []);
  assert.deepEqual(metadata.configSchema, CONFIG_SCHEMA);
});

test("manifest and package metadata stay in sync", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.deepEqual(manifest.configSchema, CONFIG_SCHEMA);
  assert.deepEqual(manifest.contracts.decisionProviders, [PLUGIN_ID]);
  assert.deepEqual(manifest.contracts.tools, []);
  assert.equal(pkg.openclaw.extensions[0], "./index.js");
  assert.deepEqual(
    manifest.decisionModels.map((model) => model.id),
    [FREE_MODEL, "jev-1.13", PAID_MODEL],
  );
  assert.equal(manifest.configContracts.secretInputs.paths[0].path, "apiKey");
});

test("boolean, choice, and score round-trip through noul", async () => {
  const { provider, calls } = makeProvider();
  const outcome = await provider.evaluate(
    defaultBatch(),
    context(`opencode-jev/${FREE_MODEL}`),
  );

  assert.equal(outcome.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(
    calls[0].init.headers["user-agent"],
    `${PLUGIN_ID}/${PLUGIN_VERSION}`,
  );
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].body.model, FREE_MODEL);
  assert.equal(calls[0].body.questions.escalate.type, "noul");
  assert.equal(
    Object.hasOwn(calls[0].body.questions.escalate, "legend"),
    false,
  );

  assert.deepEqual(outcome.result.answers.route, {
    type: "choice",
    choice: "support",
    probabilities: { support: 0.93, billing: 0.07 },
    confidence: 0.86,
  });
  assert.deepEqual(outcome.result.answers.urgency, {
    type: "score",
    score: 2,
    probabilities: [0, 0, 1],
    confidence: 1,
  });
  assert.deepEqual(outcome.result.answers.escalate, {
    type: "boolean",
    probabilityTrue: 0.94,
  });
  assert.deepEqual(outcome.result.usage, {
    inputTokens: 381,
    outputTokens: 64,
  });
});

test("score accepts a probabilities array and preserves a fractional score", async () => {
  const payload = defaultResponse();
  payload.answers.urgency = {
    type: "score",
    score: 1.5,
    probabilities: [0, 0.5, 0.5, 0.2],
  };

  const { provider } = makeProvider({
    fetchImpl: async () => jsonResponse(payload),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.result.answers.urgency.score, 1.5);
  assert.deepEqual(outcome.result.answers.urgency.probabilities, [0, 0.5, 0.5]);
});

test("all-zero distributions get mass on the reported answer", async () => {
  const payload = {
    model: FREE_MODEL,
    answers: {
      route: {
        type: "choice",
        choice: "billing",
        probabilities: { support: 0, billing: 0 },
      },
      urgency: {
        type: "score",
        score: 1.2,
        probabilities: { 0: 0, 1: 0, 2: 0 },
      },
      escalate: { type: "noul", noul: 0 },
    },
  };

  const { provider } = makeProvider({
    fetchImpl: async () => jsonResponse(payload),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.result.answers.route.probabilities, {
    support: 0,
    billing: 1,
  });
  assert.deepEqual(outcome.result.answers.urgency.probabilities, [0, 1, 0]);
  assert.equal(outcome.result.answers.urgency.score, 1.2);
  assert.equal(outcome.result.answers.escalate.probabilityTrue, 0);
});

test("extra response fields are ignored", async () => {
  const payload = defaultResponse();
  payload.extra = { ignored: true };
  payload.answers.route.extra = "ignored";

  const { provider } = makeProvider({
    fetchImpl: async () => jsonResponse(payload),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.result.usage, {
    inputTokens: 381,
    outputTokens: 64,
  });
  assert.deepEqual(outcome.result.answers.route, {
    type: "choice",
    choice: "support",
    probabilities: { support: 0.93, billing: 0.07 },
    confidence: 0.86,
  });
});

test("free models never send Authorization even when a key is configured", async () => {
  let keyCalls = 0;
  const { provider, calls } = makeProvider({
    config: { apiKey: "configured-secret" },
    resolveApiKey: async () => {
      keyCalls += 1;
      return "configured-secret";
    },
  });

  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.equal(keyCalls, 0);
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test("paid models return credentials-unavailable without network", async () => {
  const { provider, calls } = makeProvider({
    resolveApiKey: async () => undefined,
  });
  const outcome = await provider.evaluate(defaultBatch(), context(PAID_MODEL));

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  assert.equal(calls.length, 0);
});

test("a failing key resolver returns credentials-unavailable without network", async () => {
  const { provider, calls } = makeProvider({
    resolveApiKey: async () => {
      throw new Error("key store unavailable");
    },
  });
  const outcome = await provider.evaluate(defaultBatch(), context(PAID_MODEL));

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  assert.equal(calls.length, 0);
});

test("paid models send the bearer key", async () => {
  const { provider, calls } = makeProvider({
    resolveApiKey: async () => "test-key",
  });
  const outcome = await provider.evaluate(
    defaultBatch(),
    context(`opencode-jev/${PAID_MODEL}`),
  );

  assert.equal(outcome.status, "ok");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
});

test("HTTP statuses map to typed reasons", async () => {
  const cases = [
    [401, "authentication"],
    [403, "authentication"],
    [400, "unsupported-input"],
    [413, "unsupported-input"],
    [422, "unsupported-input"],
    [500, "transport"],
    [503, "transport"],
  ];

  for (const [status, reason] of cases) {
    const { provider } = makeProvider({
      resolveApiKey: async () => "test-key",
      fetchImpl: async () => jsonResponse({ error: "ignored" }, { status }),
    });
    const outcome = await provider.evaluate(
      defaultBatch(),
      context(PAID_MODEL),
    );
    assert.deepEqual(
      outcome,
      { status: "unavailable", reason },
      `status ${status}`,
    );
  }
});

test("429 maps to rate-limited with retryAfterMs", async () => {
  const { provider } = makeProvider({
    resolveApiKey: async () => "test-key",
    fetchImpl: async () =>
      jsonResponse({}, { status: 429, headers: { "retry-after": "2" } }),
  });
  const outcome = await provider.evaluate(defaultBatch(), context(PAID_MODEL));

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "rate-limited",
    retryAfterMs: 2000,
  });
});

test("retry-after-ms takes precedence over retry-after", async () => {
  const { provider } = makeProvider({
    resolveApiKey: async () => "test-key",
    fetchImpl: async () =>
      jsonResponse(
        {},
        {
          status: 429,
          headers: { "retry-after": "5", "retry-after-ms": "1500" },
        },
      ),
  });
  const outcome = await provider.evaluate(defaultBatch(), context(PAID_MODEL));

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "rate-limited",
    retryAfterMs: 1500,
  });
});

test("request timeout maps to transport", async () => {
  const { provider } = makeProvider({
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason ?? new Error("aborted")),
          { once: true },
        );
      }),
  });

  const outcome = await provider.evaluate(defaultBatch(), {
    model: FREE_MODEL,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 100,
  });

  assert.deepEqual(outcome, { status: "unavailable", reason: "transport" });
});

test("invalid JSON maps to invalid-response", async () => {
  const { provider } = makeProvider({
    fetchImpl: async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "invalid-response",
  });
});

test("caller cancellation rejects instead of returning unavailable", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  const { provider, calls } = makeProvider();
  await assert.rejects(
    provider.evaluate(defaultBatch(), {
      model: FREE_MODEL,
      signal: controller.signal,
      deadlineMonotonicMs: performance.now() + 5000,
    }),
    /cancelled/,
  );
  assert.equal(calls.length, 0);
});

test("mid-flight cancellation rejects", async () => {
  const controller = new AbortController();
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });

  const { provider } = makeProvider({
    fetchImpl: (url, init) => {
      signalStarted();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const evaluation = provider.evaluate(defaultBatch(), {
    model: FREE_MODEL,
    signal: controller.signal,
    deadlineMonotonicMs: performance.now() + 5000,
  });
  await started;
  controller.abort(new Error("cancelled-mid-flight"));

  await assert.rejects(evaluation, /cancelled-mid-flight/);
});

test("request preserves structured values and omits legend", async () => {
  const customBatch = {
    state: { ticket: { id: "T-1" }, notes: ["payment fails", "all users"] },
    questions: {
      route: {
        type: "choice",
        instructions: {
          goal: "route",
          rules: ["be concise", { tie: "support" }],
        },
        criteria: { a: { description: "A" }, b: ["B"], c: null },
      },
      urgency: {
        type: "score",
        instructions: null,
        criteria: [{ level: 0 }, ["minor"], null],
      },
      escalate: {
        type: "boolean",
        instructions: 7,
        criteria: { true: true, false: null },
      },
    },
  };
  const customResponse = {
    model: FREE_MODEL,
    answers: {
      route: {
        type: "choice",
        choice: "a",
        probabilities: { a: 1, b: 0, c: 0 },
      },
      urgency: { type: "score", score: 0, probabilities: [1, 0, 0] },
      escalate: { type: "noul", noul: 0.5 },
    },
  };

  const { provider, calls } = makeProvider({
    fetchImpl: async () => jsonResponse(customResponse),
  });
  const outcome = await provider.evaluate(
    customBatch,
    context(`opencode-jev/${FREE_MODEL}`),
  );

  assert.equal(outcome.status, "ok");
  const body = calls[0].body;
  assert.equal(body.model, FREE_MODEL);
  assert.deepEqual(body.state, customBatch.state);
  assert.deepEqual(
    body.questions.route.instructions,
    customBatch.questions.route.instructions,
  );
  assert.deepEqual(body.questions.route.criteria, {
    a: { description: "A" },
    b: ["B"],
    c: null,
  });
  assert.deepEqual(Object.keys(body.questions.route).sort(), [
    "criteria",
    "instructions",
    "type",
  ]);
  assert.equal(body.questions.urgency.instructions, null);
  assert.deepEqual(body.questions.urgency.criteria, [
    { level: 0 },
    ["minor"],
    null,
  ]);
  assert.deepEqual(Object.keys(body.questions.urgency).sort(), [
    "criteria",
    "instructions",
    "type",
  ]);
  assert.equal(body.questions.escalate.type, "noul");
  assert.equal(body.questions.escalate.instructions, "7");
  assert.deepEqual(body.questions.escalate.criteria, {
    true: "true",
    false: null,
  });
  assert.deepEqual(Object.keys(body.questions.escalate).sort(), [
    "criteria",
    "instructions",
    "type",
  ]);
  assert.equal(JSON.stringify(body.questions).includes("legend"), false);
});

test("state absent becomes empty string and explicit null is preserved", async () => {
  const response = {
    model: FREE_MODEL,
    answers: { q: { type: "noul", noul: 0.5 } },
  };

  for (const [state, expected] of [
    [undefined, ""],
    [null, null],
  ]) {
    const batch = { questions: { q: { type: "boolean", instructions: "q" } } };
    if (state !== undefined) batch.state = state;

    const { provider, calls } = makeProvider({
      fetchImpl: async () => jsonResponse(response),
    });
    const outcome = await provider.evaluate(batch, context());

    assert.equal(outcome.status, "ok");
    assert.equal(calls[0].body.state, expected);
  }
});

test("endpoint and host are not configurable", async () => {
  const { provider, calls } = makeProvider({
    config: {
      endpoint: "https://example.invalid/systemone",
      baseUrl: "https://example.invalid",
      host: "example.invalid",
    },
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.equal(calls[0].url, ENDPOINT);
});

test("oversized request is rejected before network", async () => {
  const batch = defaultBatch();
  batch.state = "x".repeat(MAX_BODY_BYTES);

  const { provider, calls } = makeProvider();
  const outcome = await provider.evaluate(batch, context());

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "unsupported-input",
  });
  assert.equal(calls.length, 0);
});

test("oversized response is invalid-response", async () => {
  const { provider } = makeProvider({
    fetchImpl: async () =>
      new Response("x".repeat(MAX_BODY_BYTES + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.deepEqual(outcome, {
    status: "unavailable",
    reason: "invalid-response",
  });
});

test("declared question limits are enforced before network", async () => {
  const tooManyChoices = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `choice-${index}`,
      "description",
    ]),
  );
  const tooManyScores = Array.from(
    { length: 11 },
    (_, index) => `level ${index}`,
  );

  for (const questions of [
    { q: { type: "choice", criteria: tooManyChoices } },
    { q: { type: "score", criteria: tooManyScores } },
    { q: { type: "choice", criteria: { "": "empty label", a: "A" } } },
  ]) {
    const { provider, calls } = makeProvider();
    const outcome = await provider.evaluate(
      { state: "", questions },
      context(),
    );
    assert.deepEqual(outcome, {
      status: "unavailable",
      reason: "unsupported-input",
    });
    assert.equal(calls.length, 0);
  }
});

test("missing or invalid required response fields are invalid-response", async () => {
  const base = defaultResponse();
  const payloads = [];

  const withoutModel = structuredClone(base);
  delete withoutModel.model;
  payloads.push(withoutModel);

  const withoutAnswer = structuredClone(base);
  delete withoutAnswer.answers.escalate;
  payloads.push(withoutAnswer);

  const wrongType = structuredClone(base);
  wrongType.answers.escalate = { type: "boolean", probabilityTrue: 0.5 };
  payloads.push(wrongType);

  const missingAnswerType = structuredClone(base);
  delete missingAnswerType.answers.route.type;
  payloads.push(missingAnswerType);

  const missingChoiceProbabilities = structuredClone(base);
  delete missingChoiceProbabilities.answers.route.probabilities;
  payloads.push(missingChoiceProbabilities);

  const unknownChoice = structuredClone(base);
  unknownChoice.answers.route.choice = "other";
  payloads.push(unknownChoice);

  const missingScoreProbabilities = structuredClone(base);
  delete missingScoreProbabilities.answers.urgency.probabilities;
  payloads.push(missingScoreProbabilities);

  const invalidNoul = structuredClone(base);
  invalidNoul.answers.escalate.noul = "0.5";
  payloads.push(invalidNoul);

  payloads.push([]);
  payloads.push({ model: FREE_MODEL, answers: [] });

  for (const payload of payloads) {
    const { provider } = makeProvider({
      fetchImpl: async () => jsonResponse(payload),
    });
    const outcome = await provider.evaluate(defaultBatch(), context());
    assert.deepEqual(outcome, {
      status: "unavailable",
      reason: "invalid-response",
    });
  }
});

test("confidence and usage are optional", async () => {
  const payload = defaultResponse();
  delete payload.answers.route.confidence;
  delete payload.answers.urgency.confidence;
  delete payload.usage;

  const { provider } = makeProvider({
    fetchImpl: async () => jsonResponse(payload),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.result.answers.route.confidence, undefined);
  assert.equal(outcome.result.answers.urgency.confidence, undefined);
  assert.equal(outcome.result.usage, undefined);
});

test("probabilities are bounded without changing reported answers", async () => {
  const payload = defaultResponse();
  payload.answers.route.probabilities = { support: 1.4, billing: -0.2 };
  payload.answers.route.confidence = 2;
  payload.answers.urgency.score = 9;
  payload.answers.urgency.probabilities = [2, -1, 0.25];
  payload.answers.escalate.noul = 1.7;

  const { provider } = makeProvider({
    fetchImpl: async () => jsonResponse(payload),
  });
  const outcome = await provider.evaluate(defaultBatch(), context());

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.result.answers.route.probabilities, {
    support: 1,
    billing: 0,
  });
  assert.equal(outcome.result.answers.route.confidence, 1);
  assert.equal(outcome.result.answers.urgency.score, 2);
  assert.deepEqual(outcome.result.answers.urgency.probabilities, [1, 0, 0.25]);
  assert.equal(outcome.result.answers.escalate.probabilityTrue, 1);
});

test(
  "keyFile is used only when it has no group or world permissions",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-jev-"));
    t.after(() => rm(directory, { recursive: true, force: true }));

    const goodPath = join(directory, "good.key");
    const badPath = join(directory, "bad.key");
    await writeFile(goodPath, "file-secret\n", { mode: 0o600 });
    await chmod(goodPath, 0o600);
    await writeFile(badPath, "file-secret\n", { mode: 0o644 });
    await chmod(badPath, 0o644);

    assert.equal(await readKeyFile(goodPath), "file-secret");
    assert.equal(await readKeyFile(badPath), undefined);
    assert.equal(await readKeyFile(join(directory, "missing.key")), undefined);

    const good = makeProvider({
      config: { keyFile: goodPath },
      resolveApiKey: () => readKeyFile(goodPath),
    });
    const goodOutcome = await good.provider.evaluate(
      defaultBatch(),
      context(PAID_MODEL),
    );
    assert.equal(goodOutcome.status, "ok");
    assert.equal(
      good.calls[0].init.headers.authorization,
      "Bearer file-secret",
    );

    const bad = makeProvider({
      config: { keyFile: badPath },
      resolveApiKey: () => readKeyFile(badPath),
    });
    const badOutcome = await bad.provider.evaluate(
      defaultBatch(),
      context(PAID_MODEL),
    );
    assert.deepEqual(badOutcome, {
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    assert.equal(bad.calls.length, 0);
  },
);
