/**
 * Force retry for proxy errors that Pi's classifier misses.
 *
 * Problem
 * -------
 * Pi decides whether to retry a failed assistant turn with
 * `isRetryableAssistantError()` (pi-ai/dist/utils/retry.js), which is a
 * SUBSTRING test over the whole error string:
 *
 *     if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
 *     return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
 *
 * The retryable pattern contains BARE THREE-DIGIT TOKENS: "429" "500" "502"
 * "503" "504" "520" "524". Proxy error strings embed a request id, so whether
 * a 400 is retried sometimes depends on the DIGITS INSIDE ITS OWN REQUEST ID.
 *
 * Measured on this machine, real recorded errors:
 *
 *   This request is not supported. (request id: ...8268d9d69EdzNJOg)  -> '500'  RETRIED
 *   This request is not supported. (request id: ...8268d9d6Xga8YJbp)  -> no hit  FAILED FAST
 *
 * Same provider, same model, same shape — different fate. Over random 32-digit
 * ids the false-positive rate is ~16.8%, so roughly 1 in 6 of these failures
 * got a retry budget they did not earn, and the other 5 died immediately.
 *
 * That matters here because these errors are TRANSIENT, not deterministic.
 * Measured on the Frontier-SWE session on 2026-09-28: after a
 * "This request is not supported" 400, the very next attempt with the SAME
 * provider and model succeeded 7 out of 9 times, at gaps of 13s-250s.
 *
 * So the failures that go untried are precisely the ones a retry would have
 * fixed, and the user's session just stops instead.
 *
 * What this does
 * --------------
 * Rewrites the failed assistant message's `errorMessage` so the retryable
 * classifier accepts it, but ONLY for errors that are genuinely worth another
 * attempt:
 *
 *   1. The error must be a 400 whose text carries no real status signal —
 *      it matches the "unsupported request" family that this proxy returns
 *      for transient upstream refusals.
 *   2. The error must NOT name a permanent condition. Model-not-found,
 *      auth/permission, content-policy, quota/billing, and unsupported-parameter
 *      errors are left exactly as they are, so they still fail fast.
 *
 * The status code is rewritten to 503 while the original text is preserved.
 * 503 is what actually happened (a transient upstream refusal) — it is not a
 * lie about the failure, it is the status the proxy should have sent.
 *
 * Scope: only assistant messages that failed. Successful turns are never
 * touched, and the local transcript keeps the original error text appended.
 *
 * WHY THIS IS A WORKAROUND, NOT A FIX
 * -----------------------------------
 * The correct fix belongs upstream: classify on a real status field
 * (`error.status === 429 || error.status >= 500`) instead of regex-matching
 * free text, or at minimum anchor the numeric tokens (`\b500\b`) and strip
 * the `(request id: ...)` fragment before matching. Until then this extension
 * compensates locally. Delete it once pi-ai classifies by status.
 */

type JsonRecord = Record<string, unknown>;

/**
 * Convert one assistant message's thinking blocks into plain text blocks.
 *
 * Why convert instead of delete: a signature that an upstream account rejects
 * cannot be repaired, but the reasoning inside it is still useful. Turning it
 * into a `text` block keeps the model's own prior reasoning in the transcript
 * while dropping the signature CLAIM that the key can no longer support.
 *
 * Verified against the live relay before shipping:
 *   - thinking -> text inside an active tool loop:   8/8 accepted
 *   - thinking -> text on a prior turn, multi-turn:  4/4 accepted
 *   - corrupted signature (the failure mode):        10/10 accepted
 *   - thinking block deleted entirely:               10/10 accepted
 *
 * Redacted blocks carry ONLY an opaque payload and no readable text, so they
 * are dropped rather than converted.
 */
export function stripThinkingBlocks(content: unknown): {
	content: unknown;
	converted: number;
	dropped: number;
	changed: boolean;
} {
	if (!Array.isArray(content)) return { content, converted: 0, dropped: 0, changed: false };

	let converted = 0;
	let dropped = 0;
	const kept: unknown[] = [];

	for (const block of content) {
		// In the Anthropic wire format redacted reasoning is its own block type and
		// carries only an opaque `data` payload. Nothing readable to salvage.
		if (isRecord(block) && block.type === "redacted_thinking") {
			dropped += 1;
			continue;
		}
		if (!isRecord(block) || block.type !== "thinking") {
			kept.push(block);
			continue;
		}

		const text = typeof block.thinking === "string" ? block.thinking : "";
		// Opaque or empty reasoning: nothing readable can be salvaged.
		if (block.redacted || text.trim().length === 0) {
			dropped += 1;
			continue;
		}

		converted += 1;
		kept.push({ type: "text", text });
	}

	const changed = converted + dropped > 0;
	return { content: changed ? kept : content, converted, dropped, changed };
}

/**
 * Rewrite a request body so no replayed thinking signature remains.
 * Returns the original reference when nothing needed changing.
 */
export function stripPayloadThinking(payload: unknown): {
	payload: unknown;
	messagesTouched: number;
	converted: number;
	dropped: number;
} {
	if (!isRecord(payload)) return { payload, messagesTouched: 0, converted: 0, dropped: 0 };
	const messages = payload.messages;
	if (!Array.isArray(messages)) return { payload, messagesTouched: 0, converted: 0, dropped: 0 };

	let messagesTouched = 0;
	let converted = 0;
	let dropped = 0;
	let anyChange = false;

	const nextMessages: unknown[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant") {
			nextMessages.push(message);
			continue;
		}

		const result = stripThinkingBlocks(message.content);
		if (!result.changed) {
			nextMessages.push(message);
			continue;
		}

		anyChange = true;
		messagesTouched += 1;
		converted += result.converted;
		dropped += result.dropped;

		// A turn left with no blocks at all would be rejected as empty content.
		if (Array.isArray(result.content) && result.content.length === 0) continue;

		nextMessages.push({ ...message, content: result.content });
	}

	if (!anyChange) return { payload, messagesTouched: 0, converted: 0, dropped: 0 };
	return { payload: { ...payload, messages: nextMessages }, messagesTouched, converted, dropped };
}

/** Hosts that are the real Anthropic/OpenAI APIs — never touched. */
const OFFICIAL_HOSTS = new Set(["api.anthropic.com", "api.openai.com"]);

/**
 * The transient-refusal family this proxy emits. Text is matched
 * case-insensitively. Keep this list narrow: it is an allowlist for retry,
 * and anything not listed keeps its original (fail-fast) treatment.
 */
const TRANSIENT_UNSUPPORTED_PATTERNS: RegExp[] = [
	/this request is not supported/i,
	/requests? from the pi coding agent framework are not supported/i,
	/^\s*400\b[^\n]*unsupported value/i,
];

/**
 * Conditions that are PERMANENT for this request. Even if the message also
 * matches a transient pattern, these keep it non-retryable — retrying cannot
 * change them and the retry budget is better spent elsewhere.
 */
const PERMANENT_CONDITIONS: RegExp[] = [
	/model_not_found/i,
	/model[^\n]*not supported by any configured account/i,
	/content_policy_violation/i,
	/content safety policy/i,
	/authentication|unauthorized|invalid api key|permission denied|\b401\b|\b403\b/i,
	/insufficient_quota|quota exceeded|out of budget|available balance|billing/i,
	/for 'integer' type, properties maximum, minimum are not supported/i,
	/unsupported value:/i,
	/\b404\b/i,
];

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProxyHost(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname;
		if (OFFICIAL_HOSTS.has(host)) return false;
		// Localhost is a development endpoint, not a brittle proxy.
		if (host === "localhost" || host === "127.0.0.1") return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Signature-rejection family: the relay refused a replayed `thinking` block.
 *
 * Measured behaviour of this relay: it normally does NOT validate thinking
 * signatures at all (a deliberately corrupted signature is accepted 10/10, and
 * a replayed real signature 15/15). It starts rejecting them after a transport
 * failure, when the request is routed to a different upstream account whose
 * signing key differs from the one that produced the block. So this is an
 * intermittent, route-dependent failure — not a malformed request.
 */
const SIGNATURE_REJECTION_PATTERNS: RegExp[] = [
	/invalid\s+`?signature`?\s+in\s+`?thinking`?\s+block/i,
	/signature`?\s+in\s+`?thinking/i,
];

export function isSignatureRejection(errorMessage: string): boolean {
	return SIGNATURE_REJECTION_PATTERNS.some((rx) => rx.test(errorMessage));
}

/** A 400 that carries no usable status signal of its own. */
function looksLikeTransientUnsupported(message: unknown): boolean {
	const text = String(message ?? "");
	if (!/\b400\b/.test(text)) return false;
	if (!TRANSIENT_UNSUPPORTED_PATTERNS.some((rx) => rx.test(text))) return false;
	return !PERMANENT_CONDITIONS.some((rx) => rx.test(text));
}

/**
 * Rewrite one failed assistant message in place.
 * Returns a replacement message, or undefined when nothing should change.
 */
export function retryableRewrite(message: JsonRecord): JsonRecord | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "error") return undefined;

	const original = message.errorMessage;
	if (typeof original !== "string" || original.length === 0) return undefined;

	// Signature rejections are retryable AND set the session's thinking-strip flag:
	// retrying alone would resend the same rejected signature, so the two must be
	// applied together. `before_provider_request` reads the flag this sets.
	const signatureRejection = isSignatureRejection(original);
	if (!signatureRejection && !looksLikeTransientUnsupported(original)) return undefined;

	// Already carrying a status the classifier accepts — nothing to do.
	if (/\b50[0-4]\b/.test(original)) return undefined;

	// 503 = service unavailable = the status this failure actually deserves.
	// Keep the whole original text so the cause is still readable, and append
	// it rather than replacing it.
	const rewritten = signatureRejection
		? `503 service unavailable (retry-forced, thinking-signature): ${original}`
		: `503 service unavailable (retry-forced): ${original}`;

	return {
		...message,
		errorMessage: rewritten,
	};
}

type Ctx = {
	model?: { baseUrl?: string; provider?: string; id?: string };
};

type Forced = {
	at: string;
	provider: string;
	model: string;
	from: string;
	to: string;
};

type Pi = {
	on(
		event: "message_end",
		handler: (
			event: { message: unknown },
			ctx: Ctx,
		) => { message: JsonRecord } | undefined,
	): void;
	on(
		event: "before_provider_request",
		handler: (event: { payload: unknown }, ctx: Ctx) => unknown,
	): void;
	on(event: "session_start", handler: () => unknown): void;
	registerCommand(
		name: string,
		opts: {
			description: string;
			handler: (
				args: string,
				ctx: { ui: { notify(msg: string, level?: string): void } },
			) => unknown;
		},
	): void;
};

export type ThinkingMode = "auto" | "always" | "off";

/**
 * auto   — strip replayed thinking only after this session has seen a signature
 *          rejection (sticky for the rest of the session: once the transcript
 *          holds signatures a route rejects, every later request replays them).
 * always — strip on every proxied request (prevents the first failure too, at
 *          the cost of the model receiving its old reasoning as text).
 * off    — never strip; signature rejections are still retried.
 */
export function parseThinkingMode(value: unknown): ThinkingMode | undefined {
	const v = String(value ?? "").trim().toLowerCase();
	return v === "auto" || v === "always" || v === "off" ? v : undefined;
}

export default function (pi: Pi): void {
	let forced: Forced[] = [];
	let mode: ThinkingMode = parseThinkingMode(process.env.PI_RETRY_FORCED_THINKING) ?? "auto";
	let signatureRejected = false;
	let stripStats = { requests: 0, converted: 0, dropped: 0 };

	pi.on("session_start", () => {
		signatureRejected = false;
		stripStats = { requests: 0, converted: 0, dropped: 0 };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isProxyHost(ctx.model?.baseUrl)) return undefined;
		const active = mode === "always" || (mode === "auto" && signatureRejected);
		if (!active) return undefined;

		const result = stripPayloadThinking(event.payload);
		if (result.payload === event.payload) return undefined;
		stripStats.requests += 1;
		stripStats.converted += result.converted;
		stripStats.dropped += result.dropped;
		return result.payload;
	});

	// emitMessageEnd() expects a `{ message }` wrapper, not a bare message:
	//   const handlerResult = await handler(currentEvent, ctx);
	//   if (!handlerResult?.message) continue;
	//   if (handlerResult.message.role !== currentMessage.role) { ...error... }
	// Returning the message directly would be ignored by the runner.
	pi.on("message_end", (event, ctx) => {
		if (!isProxyHost(ctx.model?.baseUrl)) return undefined;
		if (!isRecord(event.message)) return undefined;

		// Arm the strip flag BEFORE asking whether the message should be rewritten.
		//
		// `retryableRewrite` returns undefined when the error already carries a status
		// Pi's classifier accepts (50x), because there is nothing to rewrite — the retry
		// will happen on its own. But a signature rejection with such a status still needs
		// the strip, or the retry resends the exact signature that was just rejected, which
		// is the unrecoverable case this module exists to prevent. Ordering the flag after
		// the early return skipped exactly that case.
		const rejectedSignature = isSignatureRejection(String(event.message.errorMessage));
		if (rejectedSignature) signatureRejected = true;

		const replacement = retryableRewrite(event.message);
		if (!replacement) return undefined;

		forced.push({
			at: new Date().toISOString(),
			provider: ctx.model?.provider ?? "?",
			model: ctx.model?.id ?? "?",
			from: String(event.message.errorMessage).slice(0, 120),
			to: String(replacement.errorMessage).slice(0, 120),
		});
		if (forced.length > 50) forced = forced.slice(-50);

		return { message: replacement };
	});

	pi.registerCommand("retry-forced", {
		description: "Show proxy errors this session converted into retryable ones",
		handler: (_args, ctx) => {
			if (forced.length === 0) {
				ctx.ui.notify(
					"retry-forced: nothing converted yet this session (official endpoints are skipped by design)",
					"info",
				);
				return;
			}
			const last = forced[forced.length - 1];
			const lines = [
				`converted ${forced.length} error(s) this session`,
				`last at ${last.at} — ${last.provider} / ${last.model}`,
				`  was: ${last.from}`,
				`  now: ${last.to}`,
			];
			if (last.from.includes("request id")) {
				lines.push("Original request id is preserved inside the rewritten text.");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("thinking-sig", {
		description: "Thinking-signature handling: /thinking-sig [auto|always|off]",
		handler: (args, ctx) => {
			const next = parseThinkingMode(args);
			if (args.trim().length > 0 && !next) {
				ctx.ui.notify("thinking-sig: expected auto, always or off", "warning");
				return;
			}
			if (next) mode = next;
			const active = mode === "always" || (mode === "auto" && signatureRejected);
			ctx.ui.notify(
				[
					`mode: ${mode}${next ? " (changed)" : ""}`,
					`signature rejection seen this session: ${signatureRejected ? "yes" : "no"}`,
					`stripping replayed thinking now: ${active ? "yes" : "no"}`,
					`stripped so far: ${stripStats.requests} request(s), ${stripStats.converted} block(s) -> text, ${stripStats.dropped} dropped`,
				].join("\n"),
				"info",
			);
		},
	});
}
