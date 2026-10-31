import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.tsx" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "hypharness",
		compatibilityDate: "2026-10-23",
		entrypoint,
	},
});
