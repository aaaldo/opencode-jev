# OpenCode Jev

`opencode-jev` is a standalone OpenClaw **decision provider** for the Jev models exposed by OpenCode's System One endpoint. It plugs into OpenClaw's `decisionModel` role and serves the core `decision_evaluate` tool with typed `boolean`, `choice`, and `score` answers.

The plugin is based on the MIT-licensed `@psxxo/typed-decisions` provider, narrowed to the OpenCode transport and stripped of its widget, hook, UI, session-action, and sys-status features.

## Models

| Model reference | Billing | Authentication |
| --- | --- | --- |
| `opencode-jev/jev-1.13-free` | Free | Never sends `Authorization` |
| `opencode-jev/jev-1.13` | Paid | Requires an OpenCode API key |
| `opencode-jev/jev-1.14` | Paid | Requires an OpenCode API key |

All three support `boolean`, `choice`, and `score` questions.

## Requirements

- OpenClaw `2026.10.7` or newer for the version 1 decision-provider contract.
- No runtime npm dependencies and no build step.
- Network access to `https://opencode.ai`.

## Installation

From this repository:

```sh
openclaw plugins validate --root .
openclaw plugins install --link .
openclaw plugins list
```

On OpenClaw versions that accept a positional root, `openclaw plugins validate .` is equivalent. Some versions also require `--accept-capabilities` when installing a plugin that declares the `decisionProviders` contract.

The install command changes your OpenClaw configuration. Review the prompt before accepting. A local path outside ClawHub may additionally require `--force` after you have reviewed the source.

## Configuration

### Free model

```json5
{
  plugins: {
    entries: {
      "opencode-jev": {
        enabled: true,
        config: {
          timeoutMs: 25000
        }
      }
    }
  },
  agents: {
    defaults: {
      decisionModel: "opencode-jev/jev-1.13-free"
    }
  }
}
```

No API key is needed. The plugin never sends an `Authorization` header for a model whose id ends with `-free`, even if a key is configured. This is deliberate: an expired or invalid key makes OpenCode reject a free request with HTTP 401.

### Paid model with a SecretRef

```json5
{
  plugins: {
    entries: {
      "opencode-jev": {
        enabled: true,
        config: {
          apiKey: {
            source: "store",
            provider: "opencode",
            id: "OPENCODE_API_KEY"
          },
          timeoutMs: 25000
        }
      }
    }
  },
  agents: {
    defaults: {
      decisionModel: "opencode-jev/jev-1.14"
    }
  }
}
```

`apiKey` also accepts a plain string. When it is a SecretRef object, the plugin asks the host for the prepared capability secret through `openclaw/plugin-sdk/secret-input-runtime`.

### Paid model with a key file

```json5
{
  plugins: {
    entries: {
      "opencode-jev": {
        enabled: true,
        config: {
          keyFile: "~/.openclaw/.secrets/opencode-jev.key",
          timeoutMs: 25000
        }
      }
    }
  },
  agents: {
    defaults: {
      decisionModel: "opencode-jev/jev-1.13"
    }
  }
}
```

The default key file is `~/.openclaw/.secrets/opencode-jev.key`. Create it with owner-only permissions:

```sh
install -m 600 /dev/null ~/.openclaw/.secrets/opencode-jev.key
# then write the key into the file with your preferred editor
```

The plugin ignores a key file that is not a regular file, is empty, or has any group or other permission. A missing or unsafe key file is reported as `credentials-unavailable`; it never logs the path content or the key.

Key resolution order for paid models:

1. `apiKey` already present as a non-empty string;
2. a prepared `apiKey` SecretRef;
3. `keyFile`.

### Per-agent selection

`agents.defaults.decisionModel` is only a default. An individual agent can select a different model in the usual OpenClaw agent configuration. The provider must still be enabled in `plugins.entries`.

## Using `decision_evaluate`

Once an effective `decisionModel` is configured, OpenClaw exposes the core `decision_evaluate` tool to the agent. Example input:

```json
{
  "state": "Le client dit que le paiement échoue pour tous les utilisateurs.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Quelle équipe doit traiter ce cas ?",
      "criteria": {
        "support": "Problème technique ou panne",
        "billing": "Question de paiement ou de facturation"
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "Quel est l'impact opérationnel ?",
      "criteria": ["Aucun impact", "Gêne mineure", "Workflow bloqué"]
    },
    "escalate": {
      "type": "boolean",
      "instructions": "Faut-il déclencher une réponse incident ?",
      "criteria": {
        "true": "Panne étendue nécessitant une intervention humaine",
        "false": "Demande routinière"
      }
    }
  }
}
```

Example result:

```json
{
  "status": "ok",
  "result": {
    "model": "jev-1.13-free",
    "answers": {
      "route": {
        "type": "choice",
        "choice": "billing",
        "confidence": 0.18,
        "probabilities": { "support": 0.41, "billing": 0.59 }
      },
      "urgency": {
        "type": "score",
        "score": 2,
        "confidence": 1,
        "probabilities": [0, 0, 1]
      },
      "escalate": {
        "type": "boolean",
        "probabilityTrue": 0.88
      }
    },
    "usage": { "inputTokens": 437, "outputTokens": 64 }
  }
}
```

The plugin preserves reported choice labels and distributions. A `score` is a zero-based rubric position and may be fractional. All-zero probabilities are replaced by a mass of 1 on the reported choice or on the rounded score index, because OpenClaw requires a positive distribution.

## Limits

- Request body: 4 MiB.
- Response body: 4 MiB.
- Questions per call: 1 to 256.
- Choice alternatives: 2 to 255.
- Score levels: 2 to 10.
- Default timeout: 25 seconds; maximum 30 seconds or the host deadline, whichever is sooner.
- One request per `evaluate`; no automatic retries.

## Error reasons

| Reason | Cause |
| --- | --- |
| `authentication` | HTTP 401 or 403 |
| `rate-limited` | HTTP 429; `retryAfterMs` is included when a retry header is present |
| `unsupported-input` | HTTP 400, 413, 422, or a locally invalid batch |
| `transport` | Network failure, timeout, HTTP 5xx, or another non-success status |
| `invalid-response` | Invalid JSON, oversized response, or a malformed required field |
| `credentials-unavailable` | A paid model has no usable key |

Caller cancellation through `context.signal` rejects the evaluation; it is never converted into an `unavailable` result. The same applies to the host's deadline signal. `isReady()` always returns `true` without network I/O; key availability is checked per call.

## Privacy and security

- The host-selected `state` and the submitted questions are sent to `https://opencode.ai/inference/systemone/v1/systemone`. Do not include secrets in evidence.
- The endpoint is fixed in code. There is no `baseUrl`, `endpoint`, or `host` setting, and redirects are rejected.
- Free models never send credentials.
- Paid models send the key only in the `Authorization` header over HTTPS.
- The plugin does not log evidence, questions, answers, or the key. It also does not send ambient conversation, files, or tool output beyond the `state` supplied by the caller.
- Key files must be owner-only. The plugin does not fall back to a cached key after a filesystem error.

## Differences from `@psxxo/typed-decisions`

- Fixed OpenCode endpoint instead of a configurable System One endpoint.
- No Control UI accessory, session extension/action, prompt hook, board widget, archive hook, sysmetrics endpoint, or `typed_decide` tool.
- `apiKey` (string or SecretRef) replaces `credential`.
- Free-model authentication suppression: `*-free` never sends `Authorization`.
- OpenCode response tolerance: `usage.cost`, `usage.opencode`, `list_cost`, and `legend` are ignored; `confidence` is optional.
- Score probabilities accept either an object indexed by `"0"`, `"1"`, ... or an array and are normalized to an array.
- Strict required-field validation: missing answer types, labels, scores, or distributions produce `invalid-response`.
- 4 MiB request and response limits (the reference used a 1 MB response cap).
- `retry-after-ms` is honored in addition to `retry-after`.
- No key cache and no last-known-good fallback; a failed key read fails closed.
- Tests use `node:test` with injected `fetch`, so the unit suite needs neither OpenClaw nor OpenCode.

## Development

```sh
npm test
```

The unit suite uses only Node built-ins and does not contact OpenCode.

Live test, disabled by default:

```sh
OPENCODE_JEV_LIVE=1 npm run test:live
```

The live test sends the sample evidence above to the free `jev-1.13-free` model. It does not use a key and asserts that no `Authorization` header is sent.

Plugin metadata validation:

```sh
openclaw plugins validate --root .
```

OpenClaw `2026.11.4` treats this command as a tool/feature authoring validator and does not accept a positional root. The entry exposes an empty, non-enumerable tool authoring metadata record so the command can validate the manifest without registering a tool; runtime loading ignores it.

## License and attribution

MIT. See [LICENSE](LICENSE).

Portions of the request and response handling are adapted from `@psxxo/typed-decisions` v1.6.19, distributed under the MIT License; copyright remains with its authors. The SecretRef configuration shape follows the MIT-licensed `@openclaw/typesafe` package (OpenClaw Foundation).

This is an independent project. It is not affiliated with or endorsed by OpenCode, OpenClaw, Typed Decisions, or the `@openclaw/typesafe` project.

## Notes and limitations

- The response schema follows the observed System One v1 response. Additional fields are tolerated, but mandatory fields are validated. Missing `model`, answer `type`, choice labels, scores, or distributions produce `invalid-response`.
- `context.isAdmissible` is not consulted by the provider; the host rechecks admission after the call.
- Some structured rubrics can be rejected by OpenCode with HTTP 422; the plugin maps that to `unsupported-input`. The core host has already accepted the same batch locally.
- Paid models require an OpenCode key with access to that model. A missing key is handled without a network call.
- The plugin does not retry, stream, or batch multiple requests.
- Configuration is read when the plugin is registered; change plugin configuration through OpenClaw's normal reload flow.
