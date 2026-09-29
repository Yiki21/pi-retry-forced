# pi-retry-forced

Force retry for proxy `400` responses that Pi's error classifier misses.

A [Pi](https://pi.dev) extension. Zero runtime dependencies.

## The problem

Pi decides whether to retry a failed assistant turn with
`isRetryableAssistantError()` from `@earendil-works/pi-ai`. That function is a
substring test over the entire error string:

```js
if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
```

The retryable pattern contains **bare three-digit tokens**:

```
"429" "500" "502" "503" "504" "520" "524"
```

LLM proxy error strings embed a request id. So whether a given failure gets
retried can depend on **the digits inside its own request id**.

Real recorded errors from one machine, same provider, same model, same shape:

| error string (tail of request id) | regex match | outcome |
|---|---|---|
| `This request is not supported. (...8268d9d69EdzNJOg)` | `500` | **retried** |
| `This request is not supported. (...8268d9d6Xga8YJbp)` | none | **failed fast** |
| `This request is not supported. (...8268d9d6AqNdevgF)` | none | **failed fast** |

Over randomly generated 32-digit ids the false-positive rate is **~16.8%**. So
roughly one in six of these failures got a retry budget it did not earn, and the
other five died immediately — even though they are the same class of error.

That matters because these errors are **transient, not deterministic**. Measured
on a real long-running session: after a `This request is not supported` 400, the
next attempt with the **same provider and model** succeeded **7 out of 9 times**,
at gaps of 13s–250s.

So the failures that go untried are exactly the ones a retry would have fixed,
and the agent session just stops instead.

## What this does

It rewrites the failed assistant message's `errorMessage` so the classifier
accepts it — but only for errors genuinely worth another attempt.

1. The error must be a `400` whose text carries no usable status signal and
   matches the transient "unsupported request" family.
2. The error must **not** name a permanent condition. Model-not-found,
   auth/permission, content-policy, quota/billing, and unsupported-parameter
   errors are left untouched and still fail fast.

The rewritten text is prefixed with `503 service unavailable (retry-forced): `
and the **entire original text is preserved**, request id included.

`503` is not a lie about what happened — a transient upstream refusal is
semantically a service-unavailable, and it is the status the proxy should have
sent. Pi's own retry path then handles backoff and budget normally.

## How it hooks in

Pi emits extension events before it evaluates the retry:

```
_handleAgentEvent            (agent-session.js)
  └─ await _emitExtensionEvent(event)        ← message_end fires here
       └─ emitMessageEnd() → _replaceMessageInPlace()   ← mutates in place
  └─ this._lastAssistantMessage = assistantMsg

_shouldRetryAfterTurn
  └─ if (this._isRetryableError(message) ...)  ← reads the same object
```

`_replaceMessageInPlace` mutates the message object in place, and the retry
check reads that same reference afterwards, so the rewrite takes effect. The
handler returns `{ message }` — returning a bare message would be silently
ignored by the runner.

## Second failure class: thinking-signature rejections

The same relays also return:

```
400 upstream rejected the request: ***.***.content.11: Invalid `signature` in `thinking` block
```

This one is not a classifier miss — it is a real upstream refusal, and it is
route-dependent:

- Measured on the live relay: a **deliberately corrupted** signature is accepted
  **10/10**, and a replayed real signature **15/15**. The relay normally does
  *not* validate thinking signatures at all.
- The failures cluster after transport trouble (a `terminated` error, then 22
  consecutive `Connection error.`s), and reuse the same block indices across
  separate incidents.

So the picture is a pooled relay: after a failure the request is routed to a
different upstream account, whose signing key differs from the one that produced
the replayed `thinking` block. Pi only considers provider + api + model when
deciding whether a signature is still valid, which cannot see that the key
authorising it has changed.

### What this does about it

Retrying alone cannot work: the retry would resend the same rejected signature.
So both halves are applied together.

1. **Retry.** The rejection is classified as retryable (503) so Pi re-issues the
   turn instead of stopping.
2. **Strip.** The `before_provider_request` hook rewrites the outgoing body so no
   replayed thinking signature remains. Reasoning is not deleted: a thinking
   block with text becomes a plain `text` block, so the model keeps its own
   prior reasoning while the unsupportable signature claim is dropped. Opaque
   `redacted_thinking` blocks and empty thinking are removed.

Verified against the real relay before shipping: thinking→text inside an active
**tool loop 8/8**, on a **prior turn 4/4**, and with a **corrupted signature
10/10**. End-to-end through Pi (injecting the rejection once), the retried
request arrived as `text+text+tool_use` with zero signature fields and the turn
completed.

### Modes

`/thinking-sig [auto|always|off]` — or set `PI_RETRY_FORCED_THINKING`.

| mode | behaviour |
|---|---|
| `auto` (default) | strip only after this session has seen a signature rejection; sticky for the rest of the session |
| `always` | strip on every proxied request, so the first failure never happens |
| `off` | never strip; rejections are still retried |

`auto` keeps normal sessions byte-identical to before, so prompt caching is
unaffected until a rejection actually happens.

## Install

```bash
pi install npm:pi-retry-forced
```

Or try it for a single invocation without touching your settings:

```bash
pi -e npm:pi-retry-forced
```

## Scope and safety

- **Proxy endpoints only.** Requests to `api.anthropic.com`, `api.openai.com`,
  and `localhost` are skipped by design — the classifier bug does not affect
  them and the rewrite would be wrong there.
- **Permanent errors are never rewritten.** See `PERMANENT_CONDITIONS` in
  `src/index.ts`.
- **Success turns are never touched.** Only a message whose `stopReason` is
  `error` is considered.
- **No retry logic is reimplemented.** The extension only makes a
  misclassified error classifiable; Pi's own backoff and budget apply.

## Command

`/retry-forced` reports what was converted this session, including the original
text so you can confirm the request id is preserved.

## This is a workaround

The correct fix belongs upstream: classify on a real status field
(`error.status === 429 || error.status >= 500`) instead of regex-matching free
text, or at minimum anchor the numeric tokens (`\b500\b`) and strip the
`(request id: ...)` fragment before matching.

Until that lands, this extension compensates locally. **Delete it once
`@earendil-works/pi-ai` classifies by status.**

## Development

```bash
npm run build      # src/index.ts -> dist/index.js
npm test           # regression cases
npm run typecheck
```

The test suite pins both directions: errors that *should* be converted, errors
that *must* still fail fast, and the thinking-block conversion (including that
`tool_use` blocks and their order survive).

## License

MIT
