import { test } from "node:test";
import assert from "node:assert/strict";

import { isProxyHost, retryableRewrite } from "../dist/index.js";

/**
 * The two regexes below are transcribed verbatim from
 * @earendil-works/pi-ai dist/utils/retry.js (0.87.1). They are duplicated here
 * on purpose: the point of these tests is that the extension moves an error
 * across THIS boundary, so the boundary has to be asserted against the real
 * patterns rather than against our own opinion of what they are.
 */
const RETRYABLE_PROVIDER_ERROR_PATTERN =
	/overloaded|currently experiencing high demand|rate.?limit|too many requests|429|500|502|503|504|520|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|exceeded request buffer limit while retrying upstream|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** Mirrors isRetryableAssistantError() from pi-ai. */
function piWouldRetry(errorMessage) {
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

function failedAssistant(errorMessage) {
	return { role: "assistant", stopReason: "error", errorMessage, content: [] };
}

// ---------------------------------------------------------------------------
// The exact errors recorded on the reporting machine, verbatim.
// ---------------------------------------------------------------------------

const TARGET_400 =
	'400 {"error":{"type":"<nil>","message":"This request is not supported. (request id: 202609280840433725148328268d9d66UzFm7bp)"},"type":"error"}';

/** Same class of error, but its id happens to contain "500". */
const ACCIDENTALLY_RETRIED_400 =
	'400 {"error":{"type":"<nil>","message":"This request is not supported. (request id: 202609280757539215850068268d9d69EdzNJOg)"},"type":"error"}';

const THIRD_PARTY_BLOCK =
	'400 {"error":{"type":"<nil>","message":"Requests from the pi coding agent framework are not supported. We do not accept requests from third-party agent frameworks, as the underlying Claude subscriptions are subject to Anthropic\'s usage policy. Direct API usage, Claude Code CLI, and Codex CLI are supported. (request id: 202609091002589889768518268d9d6RxYergkk)"},"type":"error"}';

test("documents the bug it exists to work around: id digits decide retryability", () => {
	// This is not testing OUR code. It is pinning the upstream behaviour the
	// extension compensates for. If upstream fixes this, this test SHOULD fail,
	// and that failure is the signal to delete the extension.
	assert.equal(
		piWouldRetry(TARGET_400),
		false,
		"target error is currently NOT retryable (the bug)",
	);
	assert.equal(
		piWouldRetry(ACCIDENTALLY_RETRIED_400),
		true,
		"a same-class error IS retryable purely because its id contains 500",
	);
});

// ---------------------------------------------------------------------------
// Errors that MUST be converted to retryable.
// ---------------------------------------------------------------------------

test("converts the target 400 into something pi will retry", () => {
	const rewritten = retryableRewrite(failedAssistant(TARGET_400));
	assert.ok(rewritten, "should have been rewritten");
	assert.equal(piWouldRetry(rewritten.errorMessage), true);
});

test("preserves the entire original error text, request id included", () => {
	const rewritten = retryableRewrite(failedAssistant(TARGET_400));
	assert.ok(rewritten);
	assert.ok(
		rewritten.errorMessage.includes(TARGET_400),
		"original text must be contained verbatim",
	);
	assert.ok(
		rewritten.errorMessage.includes("202609280840433725148328268d9d66UzFm7bp"),
		"request id must survive for traceability",
	);
});

test("converts the third-party agent-framework block", () => {
	const rewritten = retryableRewrite(failedAssistant(THIRD_PARTY_BLOCK));
	assert.ok(rewritten);
	assert.equal(piWouldRetry(rewritten.errorMessage), true);
});

test("reports the failure as 503, the status it actually deserved", () => {
	const rewritten = retryableRewrite(failedAssistant(TARGET_400));
	assert.ok(rewritten);
	assert.match(rewritten.errorMessage, /^503 service unavailable \(retry-forced\):/);
});

test("leaves role and stopReason intact so the message stays valid", () => {
	const rewritten = retryableRewrite(failedAssistant(TARGET_400));
	assert.ok(rewritten);
	assert.equal(rewritten.role, "assistant");
	assert.equal(rewritten.stopReason, "error");
});

// ---------------------------------------------------------------------------
// Errors that MUST NOT be converted: retrying cannot change them.
// ---------------------------------------------------------------------------

const MUST_STAY_FAIL_FAST = [
	[
		"model_not_found",
		'404 {"error":{"message":"Model \\"claude-fable-5\\" is not supported by any configured account in this group","type":"model_not_found"},"type":"error"}',
	],
	[
		"integer schema bounds (a different bug, already fixed elsewhere)",
		'400 {"error":{"type":"<nil>","message":"***.***.custom: For \'integer\' type, properties maximum, minimum are not supported (request id: 202609230610234238955118268d9d6)"},"type":"error"}',
	],
	[
		"content policy violation",
		'400 {"error":{"type":"content_policy_violation","message":"Please modify your input and try again as it violates our content safety policy. (request id: 202609290000000000000000000d9d6)"},"type":"error"}',
	],
	[
		"unsupported parameter value",
		'z-open-api-gpt-openai-responses API error (400): {"message":"Unsupported value: \'minimal\' is not supported with the \'gpt-6-luna\' model.","type":"invalid_request_error"}',
	],
	[
		"quota / billing exhaustion",
		'400 {"error":{"type":"<nil>","message":"insufficient_quota: billing hard limit reached (request id: 202609290000000000000000000d9d6)"},"type":"error"}',
	],
];

for (const [label, message] of MUST_STAY_FAIL_FAST) {
	test(`does not convert: ${label}`, () => {
		const rewritten = retryableRewrite(failedAssistant(message));
		assert.equal(rewritten, undefined, `${label} must be left alone`);
	});
}

// ---------------------------------------------------------------------------
// Structural guards.
// ---------------------------------------------------------------------------

test("ignores successful turns", () => {
	const message = { role: "assistant", stopReason: "stop", content: [], errorMessage: undefined };
	assert.equal(retryableRewrite(message), undefined);
});

test("ignores non-assistant messages", () => {
	const message = { role: "user", stopReason: "error", errorMessage: TARGET_400, content: [] };
	assert.equal(retryableRewrite(message), undefined);
});

test("is idempotent: an already-retryable message is not rewritten again", () => {
	const once = retryableRewrite(failedAssistant(TARGET_400));
	assert.ok(once);
	// Once rewritten it already carries 503, so a second pass must decline.
	assert.equal(retryableRewrite(once), undefined);
});

test("ignores an empty or missing errorMessage", () => {
	assert.equal(retryableRewrite({ role: "assistant", stopReason: "error", content: [] }), undefined);
	assert.equal(
		retryableRewrite({ role: "assistant", stopReason: "error", errorMessage: "", content: [] }),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// Endpoint scoping: never touch official APIs or localhost.
// ---------------------------------------------------------------------------

test("scope: skips official and local endpoints, applies to proxies", () => {
	assert.equal(isProxyHost("https://api.anthropic.com"), false);
	assert.equal(isProxyHost("https://api.openai.com/v1"), false);
	assert.equal(isProxyHost("http://localhost:8080"), false);
	assert.equal(isProxyHost("http://127.0.0.1:1234"), false);
	assert.equal(isProxyHost(undefined), false);
	assert.equal(isProxyHost("not a url"), false);
	assert.equal(isProxyHost("https://z.open-api.ai"), true);
	assert.equal(isProxyHost("https://some-proxy.example.com/v1"), true);
});
