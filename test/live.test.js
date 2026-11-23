import assert from "node:assert/strict";
import test from "node:test";

import { ENDPOINT, createDecisionProvider } from "../index.js";

const enabled = process.env.OPENCODE_JEV_LIVE === "1";

test(
  "live jev-1.13-free returns typed answers without a key",
  { skip: !enabled, timeout: 40_000 },
  async () => {
    let status;
    let authorization;
    let requestUrl;

    const provider = createDecisionProvider({
      config: { timeoutMs: 30_000 },
      resolveApiKey: async () => undefined,
      fetchImpl: async (url, init) => {
        requestUrl = url;
        authorization = init.headers.authorization;
        const response = await fetch(url, init);
        status = response.status;
        return response;
      },
    });

    const outcome = await provider.evaluate(
      {
        state:
          "Le client dit que le paiement échoue pour tous les utilisateurs.",
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
      },
      {
        model: "opencode-jev/jev-1.13-free",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 30_000,
      },
    );

    assert.equal(requestUrl, ENDPOINT);
    assert.equal(status, 200);
    assert.equal(authorization, undefined);
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));

    const { result } = outcome;
    assert.equal(result.model, "jev-1.13-free");
    assert.equal(result.answers.route.type, "choice");
    assert.equal(result.answers.urgency.type, "score");
    assert.equal(result.answers.escalate.type, "boolean");

    const route = result.answers.route;
    assert.equal(typeof route.choice, "string");
    assert.ok(Object.hasOwn(route.probabilities, route.choice));

    const urgency = result.answers.urgency;
    assert.ok(Number.isFinite(urgency.score));
    assert.ok(urgency.score >= 0 && urgency.score <= 2);
    assert.equal(urgency.probabilities.length, 3);

    const escalate = result.answers.escalate;
    assert.ok(Number.isFinite(escalate.probabilityTrue));
    assert.ok(escalate.probabilityTrue >= 0 && escalate.probabilityTrue <= 1);

    if (result.usage) {
      assert.ok(Number.isFinite(result.usage.inputTokens));
      assert.ok(Number.isFinite(result.usage.outputTokens));
    }
  },
);
