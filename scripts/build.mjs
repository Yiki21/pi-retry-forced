import { build } from "esbuild";

await build({
	entryPoints: ["src/index.ts"],
	outfile: "dist/index.js",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: false,
	// The extension is loaded by Pi's own runtime; only node builtins are
	// external. There are no third-party runtime dependencies by design.
	external: ["node:*"],
	banner: {
		js: "// pi-retry-forced — built by scripts/build.mjs. Edit src/index.ts, not this file.",
	},
});

console.log("built dist/index.js");
