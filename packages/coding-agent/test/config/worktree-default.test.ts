import { expect, test } from "bun:test";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";

test("new worktrees do not clone ignored dependency artifacts by default", () => {
	const setting = SETTINGS_SCHEMA["worktree.clone"];
	expect(setting.default).toBe(false);
	expect(setting.ui.description).toContain("node_modules");
	expect(setting.ui.description).toContain("Disabled by default");
});
