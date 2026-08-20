/* ------------------------------------------------------------------ */
/* Mock tests for src/menu.ts (pure buildMenuItemDefs) + writeback's    */
/* groupChoicesFor (used by the "move to group" picker).               */
/*                                                                     */
/* Run:   node --test --test-isolation=none tests/menu.test.cjs         */
/*                                                                     */
/* src/menu.ts imports obsidian, so it is bundled with the module      */
/* aliased to tests/mocks/obsidian.cjs (stubs — tests never open       */
/* menus/modals). The thin UI bindings (showNodeMenu / modals) need     */
/* the obsidian runtime and are not unit-tested.                       */
/* ------------------------------------------------------------------ */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(__dirname, ".tmp");
const MOCK_OBSIDIAN = path.join(__dirname, "mocks", "obsidian.cjs").replace(/\\/g, "/");
const { execFileSync } = require("node:child_process");
const esbuildBin = path.join(path.dirname(require.resolve("esbuild")), "..", "bin", "esbuild");

function ensureBundle(src, outfile, extraArgs = []) {
	const needsRebuild =
		!fs.existsSync(outfile) ||
		(() => {
			try {
				return fs.statSync(src).mtimeMs > fs.statSync(outfile).mtimeMs;
			} catch {
				return true;
			}
		})();
	if (!needsRebuild) return;
	fs.mkdirSync(TMP_DIR, { recursive: true });
	execFileSync(
		process.execPath,
		[esbuildBin, src, "--bundle", "--format=cjs", "--platform=node", ...extraArgs, `--outfile=${outfile}`, "--log-level=warning"],
		{ stdio: "inherit" }
	);
}

ensureBundle(path.join(ROOT, "src", "menu.ts"), path.join(TMP_DIR, "menu.cjs"), [
	`--alias:obsidian=${MOCK_OBSIDIAN}`,
]);
ensureBundle(path.join(ROOT, "src", "writeback.ts"), path.join(TMP_DIR, "writeback.cjs"));

const menu = require(path.join(TMP_DIR, "menu.cjs"));
const { buildMenuItemDefs } = menu;
const wb = require(path.join(TMP_DIR, "writeback.cjs"));
const { groupChoicesFor } = wb;

/* ------------------------------------------------------------------ */
/* Fixtures (tree nodes — no vault needed for menu defs)               */
/* ------------------------------------------------------------------ */

const fileNode = { kind: "file", title: "notes", path: "notes.md", subpath: "#sec" };
const searchNode = { kind: "search", title: "s", query: "hello" };
const urlNode = { kind: "url", title: "u", url: "https://example.com" };
const graphNode = { kind: "graph", title: "g", options: {} };
const folderNode = { kind: "folder", title: "docs", path: "docs" };
const groupNode = { kind: "group", title: "G1", children: [] };

const ids = (defs) => defs.map((d) => d.id);
const byId = (defs, id) => defs.find((d) => d.id === id);

/* ------------------------------------------------------------------ */
/* buildMenuItemDefs                                                   */
/* ------------------------------------------------------------------ */

describe("buildMenuItemDefs：file", () => {
	test("项顺序：打开/新标签/复制链接/重命名/移动到/删除，分隔线位置正确", () => {
		const defs = buildMenuItemDefs(fileNode);
		assert.deepStrictEqual(ids(defs), ["open", "openNewTab", "copy", "rename", "moveToGroup", "delete"]);
		assert.strictEqual(byId(defs, "rename").separatorBefore, true);
		assert.strictEqual(byId(defs, "delete").separatorBefore, true);
		assert.strictEqual(byId(defs, "open").separatorBefore, undefined);
		assert.strictEqual(byId(defs, "copy").title, "复制链接");
		assert.strictEqual(byId(defs, "delete").dangerous, undefined);
	});
});

describe("buildMenuItemDefs：search / url / graph", () => {
	test("search：复制查询；url：复制链接；graph：无复制项", () => {
		const s = buildMenuItemDefs(searchNode);
		assert.deepStrictEqual(ids(s), ["open", "openNewTab", "copy", "rename", "moveToGroup", "delete"]);
		assert.strictEqual(byId(s, "copy").title, "复制查询");

		const u = buildMenuItemDefs(urlNode);
		assert.deepStrictEqual(ids(u), ["open", "openNewTab", "copy", "rename", "moveToGroup", "delete"]);
		assert.strictEqual(byId(u, "copy").title, "复制链接");

		const g = buildMenuItemDefs(graphNode);
		assert.deepStrictEqual(ids(g), ["open", "openNewTab", "rename", "moveToGroup", "delete"]);
		assert.strictEqual(byId(g, "copy"), undefined);
	});
});

describe("buildMenuItemDefs：folder", () => {
	test("无「新标签页打开」/复制；含展开项", () => {
		const defs = buildMenuItemDefs(folderNode);
		assert.deepStrictEqual(ids(defs), ["toggle", "rename", "moveToGroup", "delete"]);
		assert.strictEqual(byId(defs, "toggle").title, "展开");
		assert.strictEqual(byId(defs, "openNewTab"), undefined);
		assert.strictEqual(byId(defs, "copy"), undefined);
	});
});

describe("buildMenuItemDefs：group", () => {
	test("含 展开/重命名/移动到/删除；删除 dangerous + confirm 含组名与数量", () => {
		const defs = buildMenuItemDefs(groupNode, { groupItemCount: 5 });
		assert.deepStrictEqual(ids(defs), ["toggle", "rename", "moveToGroup", "delete"]);
		const del = byId(defs, "delete");
		assert.strictEqual(del.dangerous, true);
		assert.ok(del.confirm.includes("G1"));
		assert.ok(del.confirm.includes("5"));
	});

	test("展开态 → 「收起」", () => {
		const defs = buildMenuItemDefs(groupNode, { expanded: true, canToggle: true });
		assert.strictEqual(byId(defs, "toggle").title, "收起");
	});

	test("canToggle=false → 无展开项", () => {
		const defs = buildMenuItemDefs(groupNode, { canToggle: false });
		assert.strictEqual(byId(defs, "toggle"), undefined);
	});
});

describe("buildMenuItemDefs：只读模式", () => {
	test("file：保留只读项，过滤写操作", () => {
		const defs = buildMenuItemDefs(fileNode, { readonly: true });
		assert.deepStrictEqual(ids(defs), ["open", "openNewTab", "copy"]);
	});

	test("search：保留 open/copy", () => {
		const defs = buildMenuItemDefs(searchNode, { readonly: true });
		assert.deepStrictEqual(ids(defs), ["open", "openNewTab", "copy"]);
	});

	test("graph：只留打开类", () => {
		const defs = buildMenuItemDefs(graphNode, { readonly: true });
		assert.deepStrictEqual(ids(defs), ["open", "openNewTab"]);
	});

	test("group：只留展开", () => {
		const defs = buildMenuItemDefs(groupNode, { readonly: true });
		assert.deepStrictEqual(ids(defs), ["toggle"]);
	});
});

/* ------------------------------------------------------------------ */
/* groupChoicesFor（「移动到分组…」的目标列表）                          */
/* ------------------------------------------------------------------ */

const G = (title, items = []) => ({ type: "group", ctime: 1, title, items });
const F = (p) => ({ type: "file", ctime: 1, path: p });

describe("groupChoicesFor（移动到分组的可选目标）", () => {
	test("目标列表排除自身与后代", () => {
		const data = { items: [G("A", [F("x.md"), G("A / B", [F("y.md")])]), G("C", [])], groups: [] };
		const a = data.items[0];
		const choices = groupChoicesFor(data, a);
		assert.deepStrictEqual(choices.map((c) => c.label), ["C"]);
	});

	test("嵌套分组 label 带层级路径", () => {
		const data = { items: [G("A", [G("B", [G("C", [])])])], groups: [] };
		const choices = groupChoicesFor(data, data.items[0].items[0].items[0]);
		assert.deepStrictEqual(choices.map((c) => c.label), ["A", "A / B"]);
	});

	test("普通条目 → 全部分组可选（含自身所在组）", () => {
		const data = { items: [G("A", [F("x.md")]), G("B", [])], groups: [] };
		const x = data.items[0].items[0];
		const choices = groupChoicesFor(data, x);
		assert.deepStrictEqual(choices.map((c) => c.label), ["A", "B"]);
	});

	test("旧形状 groups 也可选", () => {
		const data = { items: [], groups: [{ id: "g1", title: "LG", items: [] }] };
		const choices = groupChoicesFor(data, null);
		assert.deepStrictEqual(choices.map((c) => c.label), ["LG"]);
	});
});
