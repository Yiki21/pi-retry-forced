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

The test suite pins both directions: errors that *should* be converted, and
errors that *must* still fail fast.

## License

MIT
