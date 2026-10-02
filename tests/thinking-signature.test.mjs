import { test } from "node:test";
import assert from "node:assert/strict";

import {
	isSignatureRejection,
	parseThinkingMode,
	retryableRewrite,
	stripPayloadThinking,
	stripThinkingBlocks,
} from "../dist/index.js";

/** Mirrors isRetryableAssistantError() from @earendil-works/pi-ai 0.87.1. */
const RETRYABLE =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|520|524|service.?unavailable|server.?error|internal.?error|timeout|terminated/i;
const NON_RETRYABLE = /insufficient_quota|quota exceeded|out of budget|available balance|billing/i;
const piWouldRetry = (e) => !NON_RETRYABLE.test(e) && RETRYABLE.test(e);

// Verbatim from the reporting machine (2026-09-29 01:12, and the older form).
const SIG_NEW =
	'400 {"error":{"type":"<nil>","message":"upstream rejected the request: ***.***.content.11: Invalid `signature` in `thinking` block (request id: 202609290111575062335268268d9d60QBFyOIz)"},"type":"error"}';
const SIG_OLD =
	'400 {"error":{"type":"<nil>","message":"***.***.content.142: Invalid `signature` in `thinking` block (request id: 202609280350441234567898268d9d6AbCdEfGh)"},"type":"error"}';

const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage, content: [] });

// ---------------------------------------------------------------------------
// Retry side
// ---------------------------------------------------------------------------

test("signature rejection: the upstream classifier does not retry it (the bug)", () => {
	assert.equal(piWouldRetry(SIG_NEW), false);
});

test("signature rejection is recognised in both wordings", () => {
	assert.equal(isSignatureRejection(SIG_NEW), true);
	assert.equal(isSignatureRejection(SIG_OLD), true);
	assert.equal(isSignatureRejection("400 This request is not supported."), false);
});

test("signature rejection becomes retryable and keeps its original text", () => {
	for (const err of [SIG_NEW, SIG_OLD]) {
		const r = retryableRewrite(failed(err));
		assert.ok(r, "should be rewritten");
		assert.equal(piWouldRetry(r.errorMessage), true);
		assert.ok(r.errorMessage.includes(err), "original preserved verbatim");
		assert.match(r.errorMessage, /thinking-signature/);
	}
});

// ---------------------------------------------------------------------------
// Request side: block-level conversion
// ---------------------------------------------------------------------------

test("thinking with text becomes a plain text block and the signature is gone", () => {
	const r = stripThinkingBlocks([
		{ type: "thinking", thinking: "173*29 = 5017", signature: "CAQSxwQK..." },
		{ type: "text", text: "5017" },
	]);
	assert.equal(r.changed, true);
	assert.equal(r.converted, 1);
	assert.deepEqual(r.content, [
		{ type: "text", text: "173*29 = 5017" },
		{ type: "text", text: "5017" },
	]);
	assert.ok(!JSON.stringify(r.content).includes("signature"));
});

test("redacted_thinking and empty thinking are dropped, not converted", () => {
	const r = stripThinkingBlocks([
		{ type: "redacted_thinking", data: "opaque" },
		{ type: "thinking", thinking: "   ", signature: "x" },
		{ type: "text", text: "kept" },
	]);
	assert.equal(r.dropped, 2);
	assert.equal(r.converted, 0);
	assert.deepEqual(r.content, [{ type: "text", text: "kept" }]);
});

test("tool_use blocks survive untouched and keep their order", () => {
	const toolUse = { type: "tool_use", id: "toolu_abc", name: "bash", input: { command: "ls" } };
	const r = stripThinkingBlocks([{ type: "thinking", thinking: "run ls", signature: "s" }, toolUse]);
	assert.deepEqual(r.content, [{ type: "text", text: "run ls" }, toolUse]);
});

test("content without thinking is returned by reference (no churn)", () => {
	const content = [{ type: "text", text: "hi" }];
	const r = stripThinkingBlocks(content);
	assert.equal(r.changed, false);
	assert.equal(r.content, content);
});

// ---------------------------------------------------------------------------
// Request side: payload-level
// ---------------------------------------------------------------------------

test("payload: every assistant turn is stripped, user and tool_result turns are not", () => {
	const userTurn = { role: "user", content: [{ type: "text", text: "q" }] };
	const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
	const payload = {
		model: "claude-opus-5-5",
		messages: [
			userTurn,
			{ role: "assistant", content: [{ type: "thinking", thinking: "a", signature: "s1" }, { type: "tool_use", id: "t1", name: "x", input: {} }] },
			toolResult,
			{ role: "assistant", content: [{ type: "thinking", thinking: "b", signature: "s2" }, { type: "text", text: "done" }] },
		],
		thinking: { type: "adaptive" },
	};
	const r = stripPayloadThinking(payload);
	assert.equal(r.messagesTouched, 2);
	assert.equal(r.converted, 2);
	assert.ok(!JSON.stringify(r.payload).includes('"signature"'));
	assert.equal(r.payload.messages[0], userTurn, "user turn by reference");
	assert.equal(r.payload.messages[2], toolResult, "tool_result by reference");
	assert.deepEqual(r.payload.thinking, { type: "adaptive" }, "thinking config itself stays on");
	assert.equal(payload.messages[1].content[0].type, "thinking", "input payload not mutated");
});

test("payload: an assistant turn left empty is removed instead of sent empty", () => {
	const payload = {
		messages: [
			{ role: "user", content: "q" },
			{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
			{ role: "user", content: "again" },
		],
	};
	const r = stripPayloadThinking(payload);
	assert.equal(r.payload.messages.length, 2);
	assert.ok(r.payload.messages.every((m) => m.role === "user"));
});

test("payload: nothing to strip returns the same reference", () => {
	const payload = { messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }] }] };
	assert.equal(stripPayloadThinking(payload).payload, payload);
});

test("payload: non-Anthropic shapes (OpenAI Responses `input`) are ignored", () => {
	const payload = { model: "gpt", input: [{ role: "assistant", content: [{ type: "reasoning" }] }] };
	assert.equal(stripPayloadThinking(payload).payload, payload);
});

test("mode parsing", () => {
	assert.equal(parseThinkingMode("auto"), "auto");
	assert.equal(parseThinkingMode(" ALWAYS "), "always");
	assert.equal(parseThinkingMode("off"), "off");
	assert.equal(parseThinkingMode(""), undefined);
	assert.equal(parseThinkingMode("yes"), undefined);
});

// ---------------------------------------------------------------------------
// Ordering: the strip flag must be armed before the rewrite decision
// ---------------------------------------------------------------------------

/**
 * Drive the real extension handlers with a stub `pi`.
 *
 * Returns the registered handlers so a test can play a rejection through
 * `message_end` and then check what `before_provider_request` does to the next
 * outgoing payload — which is the only way to observe the two-halves contract.
 */
async function driveExtension() {
	const handlers = new Map();
	const { default: create } = await import("../dist/index.js");
	create({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	});
	return handlers;
}

const PROXY_CTX = { model: { baseUrl: "https://pooled-relay.example/v1", provider: "anthropic", id: "claude" } };

/** A payload carrying a replayed thinking block, which is what must be stripped. */
const payloadWithThinking = () => ({
	messages: [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal", signature: "STALE=" },
				{ type: "text", text: "answer" },
			],
		},
	],
});

test("a signature rejection carrying a retryable status still arms the strip", async () => {
	// The 500 here is the whole point: `retryableRewrite` early-returns because Pi's
	// classifier already accepts 50x, so the flag used to never be set and the retry
	// resent the rejected signature verbatim.
	const withRetryableStatus =
		"500 upstream rejected the request: content.3: Invalid `signature` in `thinking` block (request id: abc123)";

	const handlers = await driveExtension();

	// Before: nothing is stripped, because the flag is unset.
	const before = handlers.get("before_provider_request")(
		{ payload: payloadWithThinking() },
		PROXY_CTX,
	);
	assert.equal(before, undefined, "no stripping before any rejection is seen");

	// Play the rejection through message_end.
	handlers.get("message_end")(
		{ message: failed(withRetryableStatus) },
		PROXY_CTX,
	);

	// After: the next request must have its thinking stripped.
	const after = handlers.get("before_provider_request")(
		{ payload: payloadWithThinking() },
		PROXY_CTX,
	);
	assert.ok(after, "the payload must be rewritten once a signature rejection was seen");
	assert.equal(
		JSON.stringify(after).includes("STALE="),
		false,
		"the rejected signature must not be replayed on the retry",
	);
});

test("an unrelated 500 does not arm the strip", async () => {
	const handlers = await driveExtension();
	handlers.get("message_end")(
		{ message: failed("500 internal server error (request id: zzz)") },
		PROXY_CTX,
	);
	assert.equal(
		handlers.get("before_provider_request")({ payload: payloadWithThinking() }, PROXY_CTX),
		undefined,
		"only a signature rejection justifies rewriting history",
	);
});

test("off mode never strips even after a rejection", async () => {
	process.env.PI_RETRY_FORCED_THINKING = "off";
	try {
		const handlers = await driveExtension();
		handlers.get("message_end")(
			{ message: failed("400 Invalid `signature` in `thinking` block (request id: q)") },
			PROXY_CTX,
		);
		assert.equal(
			handlers.get("before_provider_request")({ payload: payloadWithThinking() }, PROXY_CTX),
			undefined,
			"mode=off disables stripping regardless of what was seen",
		);
	} finally {
		delete process.env.PI_RETRY_FORCED_THINKING;
	}
});
