/* ------------------------------------------------------------------ */
/* Mock tests for src/writeback.ts (pure logic + thin adapters).        */
/*                                                                     */
/* Run:   node --test --test-isolation=none tests/writeback.test.cjs    */
/*                                                                     */
/* The module (plus its ./tree import) is bundled to CJS first          */
/* (tests/.tmp/writeback.cjs); src/tree.ts is also bundled separately   */
/* (tests/.tmp/tree.cjs) so tests can build trees for mapNodesToRaw.    */
/* ------------------------------------------------------------------ */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(__dirname, ".tmp");
const { execFileSync } = require("node:child_process");
const esbuildBin = path.join(path.dirname(require.resolve("esbuild")), "..", "bin", "esbuild");

function ensureBundle(src, outfile) {
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
	// esbuild's JS API spawns its native service with piped stdio, which
	// sandboxed environments block (EPERM); run the CLI shim instead.
	execFileSync(
		process.execPath,
		[esbuildBin, src, "--bundle", "--format=cjs", "--platform=node", `--outfile=${outfile}`, "--log-level=warning"],
		{ stdio: "inherit" }
	);
}

ensureBundle(path.join(ROOT, "src", "writeback.ts"), path.join(TMP_DIR, "writeback.cjs"));
ensureBundle(path.join(ROOT, "src", "tree.ts"), path.join(TMP_DIR, "tree.cjs"));

const wb = require(path.join(TMP_DIR, "writeback.cjs"));
const {
	locateItem,
	keyOrdinalOf,
	locateItemAtOrdinal,
	collectGroups,
	groupChoicesFor,
	countGroupItems,
	moveItemInData,
	applyMoveToGroupChoice,
	removeItemFromData,
	renameItemInData,
	validateBookmarksData,
	parseBookmarksFile,
	cloneBookmarksData,
	restoreData,
	mapNodesToRaw,
	isGroupContainer,
	groupContains,
	applyToFile,
	commitWrite,
} = wb;
const tree = require(path.join(TMP_DIR, "tree.cjs"));
const { buildTree } = tree;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const F = (p, extra = {}) => ({ type: "file", ctime: 1, path: p, ...extra });
const D = (p) => ({ type: "folder", ctime: 1, path: p });
const G = (title, items = []) => ({ type: "group", ctime: 1, title, items });

/** New-shape data: a.md, group G1 (b.md, group G2 (c.md)), d.md. */
const NEW_DATA = () => ({
	items: [F("a.md"), G("G1", [F("b.md"), G("G2", [F("c.md")])]), F("d.md")],
	groups: [],
});

/** Legacy-shape data: items a.md; groups g1 (b.md), g2 (empty). */
const LEGACY_DATA = () => ({
	items: [F("a.md")],
	groups: [
		{ id: "g1", title: "G1", items: [F("b.md")] },
		{ id: "g2", title: "G2", items: [] },
	],
});

const titles = (items) => items.map((i) => i.title ?? i.path ?? i.query ?? i.url ?? "");
const itemPaths = (items) => items.map((i) => i.path);
/** path-or-title (groups have no path). */
const names = (items) => items.map((i) => i.path ?? i.title);

/* ------------------------------------------------------------------ */
/* locateItem                                                          */
/* ------------------------------------------------------------------ */

describe("locateItem", () => {
	test("顶层命中", () => {
		const data = NEW_DATA();
		const loc = locateItem(data, (it) => it.path === "a.md");
		assert.ok(loc);
		assert.strictEqual(loc.item.path, "a.md");
		assert.strictEqual(loc.index, 0);
		assert.strictEqual(loc.parentList, data.items);
		assert.deepStrictEqual(loc.groupPath, []);
		assert.strictEqual(loc.legacyGroup, false);
	});

	test("分组内命中", () => {
		const data = NEW_DATA();
		const loc = locateItem(data, (it) => it.path === "b.md");
		assert.ok(loc);
		assert.strictEqual(loc.index, 0);
		assert.strictEqual(loc.parentList, data.items[1].items);
		assert.deepStrictEqual(loc.groupPath, [data.items[1]]);
	});

	test("嵌套分组内命中", () => {
		const data = NEW_DATA();
		const loc = locateItem(data, (it) => it.path === "c.md");
		assert.ok(loc);
		assert.deepStrictEqual(loc.groupPath, [data.items[1], data.items[1].items[1]]);
		assert.strictEqual(loc.parentList, data.items[1].items[1].items);
	});

	test("不存在返回 null", () => {
		assert.strictEqual(locateItem(NEW_DATA(), (it) => it.path === "ghost.md"), null);
		assert.strictEqual(locateItem(null, (it) => true), null);
	});

	test("旧形状：legacy 分组条目与组内条目", () => {
		const data = LEGACY_DATA();
		const g = locateItem(data, (it) => it.title === "G1");
		assert.ok(g);
		assert.strictEqual(g.legacyGroup, true);
		assert.strictEqual(g.parentList, data.groups);
		const b = locateItem(data, (it) => it.path === "b.md");
		assert.ok(b);
		assert.strictEqual(b.legacyGroup, false);
		assert.deepStrictEqual(b.groupPath, [data.groups[0]]);
	});
});

/* ------------------------------------------------------------------ */
/* keyOrdinalOf / locateItemAtOrdinal（重复书签精确定位）               */
/* ------------------------------------------------------------------ */

describe("keyOrdinalOf / locateItemAtOrdinal（重复书签精确定位）", () => {
	const fileKey = (p) => (it) => it.type === "file" && it.path === p;

	test("keyOrdinalOf：同 key 条目在数据中的序号（含分组内）", () => {
		const data = { items: [F("a.md"), F("a.md"), G("G", [F("a.md")]), F("b.md")], groups: [] };
		assert.strictEqual(keyOrdinalOf(data, fileKey("a.md"), data.items[0]), 0);
		assert.strictEqual(keyOrdinalOf(data, fileKey("a.md"), data.items[1]), 1);
		assert.strictEqual(keyOrdinalOf(data, fileKey("a.md"), data.items[2].items[0]), 2);
		assert.strictEqual(keyOrdinalOf(data, fileKey("ghost.md"), F("ghost.md")), -1);
	});

	test("keyOrdinalOf：旧形状 groups 内序号接续", () => {
		const data = LEGACY_DATA(); // items: a.md; groups: g1(b.md), g2()
		assert.strictEqual(keyOrdinalOf(data, fileKey("a.md"), data.items[0]), 0);
		assert.strictEqual(keyOrdinalOf(data, fileKey("b.md"), data.groups[0].items[0]), 0);
	});

	test("locateItemAtOrdinal：命中第 n 个重复项", () => {
		const data = { items: [F("a.md"), F("a.md"), F("b.md")], groups: [] };
		const loc = locateItemAtOrdinal(data, fileKey("a.md"), 1);
		assert.ok(loc);
		assert.strictEqual(loc.item, data.items[1]);
		assert.strictEqual(loc.index, 1);
	});

	test("重复书签精确命中：file 模式重读后操作第二条，第一条不受影响", () => {
		const data = { items: [F("a.md"), F("a.md"), F("b.md")], groups: [] };
		const ordinal = keyOrdinalOf(data, fileKey("a.md"), data.items[1]);
		assert.strictEqual(ordinal, 1);
		// 模拟文件重读：同一内容的全新对象（引用全部失效）
		const reread = JSON.parse(JSON.stringify(data));
		const located = locateItemAtOrdinal(reread, fileKey("a.md"), ordinal);
		assert.ok(located);
		assert.notStrictEqual(located.item, reread.items[0]);
		removeItemFromData(reread, located.item);
		assert.deepStrictEqual(reread.items.map((i) => i.path), ["a.md", "b.md"]); // 删的是第二条
	});

	test("序号越界 → null（数据已变化，由调用方回退）", () => {
		const data = { items: [F("a.md")], groups: [] };
		assert.strictEqual(locateItemAtOrdinal(data, fileKey("a.md"), 1), null);
	});
});

/* ------------------------------------------------------------------ */
/* collectGroups / groupChoicesFor / countGroupItems                   */
/* ------------------------------------------------------------------ */

describe("collectGroups", () => {
	test("新形状 DFS 顺序 + 层级 label", () => {
		const data = NEW_DATA();
		const entries = collectGroups(data);
		assert.deepStrictEqual(
			entries.map((e) => ({ label: e.label, depth: e.depth, legacy: e.legacy })),
			[
				{ label: "G1", depth: 0, legacy: false },
				{ label: "G1 / G2", depth: 1, legacy: false },
			]
		);
		assert.strictEqual(entries[0].group, data.items[1]);
	});

	test("旧形状 groups 数组", () => {
		const entries = collectGroups(LEGACY_DATA());
		assert.deepStrictEqual(
			entries.map((e) => ({ label: e.label, depth: e.depth, legacy: e.legacy })),
			[
				{ label: "G1", depth: 0, legacy: true },
				{ label: "G2", depth: 0, legacy: true },
			]
		);
	});

	test("空分组包含", () => {
		const data = { items: [G("empty", [])], groups: [] };
		const entries = collectGroups(data);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].label, "empty");
	});

	test("空数据不崩溃", () => {
		assert.deepStrictEqual(collectGroups(undefined), []);
		assert.deepStrictEqual(collectGroups({}), []);
	});
});

describe("groupChoicesFor", () => {
	test("排除自身与后代", () => {
		const data = { items: [G("G1", [F("x.md"), G("G2", [F("y.md")])]), F("z.md")], groups: [] };
		const g1 = data.items[0];
		const choices = groupChoicesFor(data, g1);
		assert.deepStrictEqual(choices.map((c) => c.label), []); // G1 自身与 G2 都被排除
	});

	test("非分组条目 → 全部可选", () => {
		const data = { items: [F("z.md"), G("G1", [G("G2", [])])], groups: [] };
		const choices = groupChoicesFor(data, data.items[0]);
		assert.deepStrictEqual(choices.map((c) => c.label), ["G1", "G1 / G2"]);
	});

	test("null → 全部可选", () => {
		const data = LEGACY_DATA();
		const choices = groupChoicesFor(data, null);
		assert.deepStrictEqual(choices.map((c) => c.label), ["G1", "G2"]);
	});
});

describe("countGroupItems", () => {
	test("统计组内全部书签（不含嵌套分组自身）", () => {
		const g = G("G1", [F("b.md"), G("G2", [F("c.md"), F("d.md")]), F("e.md")]);
		assert.strictEqual(countGroupItems(g), 4); // b.md + c.md + d.md + e.md
		assert.strictEqual(countGroupItems(G("empty", [])), 0);
	});
});

/* ------------------------------------------------------------------ */
/* moveItemInData                                                      */
/* ------------------------------------------------------------------ */

describe("moveItemInData", () => {
	test("同列表 before：源在目标前（索引修正）", () => {
		const data = { items: [F("A.md"), F("B.md"), F("C.md")], groups: [] };
		const a = data.items[0];
		const c = data.items[2];
		const ok = moveItemInData(data, a, null, 2); // before C
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(itemPaths(data.items), ["B.md", "A.md", "C.md"]);
	});

	test("同列表 before：源在目标后", () => {
		const data = { items: [F("A.md"), F("B.md"), F("C.md")], groups: [] };
		const c = data.items[2];
		const ok = moveItemInData(data, c, null, 1); // before B
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(itemPaths(data.items), ["A.md", "C.md", "B.md"]);
	});

	test("同列表 after", () => {
		const data = { items: [F("A.md"), F("B.md"), F("C.md")], groups: [] };
		const a = data.items[0];
		const ok = moveItemInData(data, a, null, 3); // after C
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(itemPaths(data.items), ["B.md", "C.md", "A.md"]);
	});

	test("跨组移入（追加）", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const g1 = data.items[1];
		const ok = moveItemInData(data, a, g1);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
		assert.deepStrictEqual(names(data.items[0].items), ["b.md", "G2", "a.md"]);
	});

	test("移出到顶层", () => {
		const data = NEW_DATA();
		const b = data.items[1].items[0];
		const ok = moveItemInData(data, b, null);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(names(data.items[1].items), ["G2"]);
		assert.deepStrictEqual(names(data.items), ["a.md", "G1", "d.md", "b.md"]);
	});

	test("group 移入自身被拒", () => {
		const data = NEW_DATA();
		const g1 = data.items[1];
		const before = JSON.stringify(data);
		assert.strictEqual(moveItemInData(data, g1, g1), false);
		assert.strictEqual(JSON.stringify(data), before); // 无副作用
	});

	test("group 移入后代被拒", () => {
		const data = NEW_DATA();
		const g1 = data.items[1];
		const g2 = data.items[1].items[1];
		const before = JSON.stringify(data);
		assert.strictEqual(moveItemInData(data, g1, g2), false);
		assert.strictEqual(JSON.stringify(data), before);
	});

	test("group 同级排序（移入自己父列表 ≠ 移入自身）", () => {
		const data = { items: [G("G1", []), F("x.md")], groups: [] };
		const g1 = data.items[0];
		assert.strictEqual(moveItemInData(data, g1, null, 2), true); // 顶层 after x.md
		assert.deepStrictEqual(names(data.items), ["x.md", "G1"]);
	});

	test("旧形状：groups 之间移动条目", () => {
		const data = LEGACY_DATA();
		const b = data.groups[0].items[0];
		const g2 = data.groups[1];
		const ok = moveItemInData(data, b, g2);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(itemPaths(data.groups[0].items), []);
		assert.deepStrictEqual(itemPaths(data.groups[1].items), ["b.md"]);
	});

	test("旧形状：legacy 分组条目在 groups 内重排", () => {
		const data = LEGACY_DATA();
		const g2 = data.groups[1];
		const ok = moveItemInData(data, g2, null, 0);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(data.groups.map((g) => g.id), ["g2", "g1"]);
	});

	test("旧形状：legacy 分组条目不可移入分组", () => {
		const data = LEGACY_DATA();
		const g2 = data.groups[1];
		const g1 = data.groups[0];
		assert.strictEqual(moveItemInData(data, g2, g1), false);
	});

	test("不存在 → false 且无副作用", () => {
		const data = NEW_DATA();
		const before = JSON.stringify(data);
		assert.strictEqual(moveItemInData(data, F("ghost.md"), null), false);
		assert.strictEqual(JSON.stringify(data), before);
	});

	test("目标不在数据中 → false", () => {
		const data = NEW_DATA();
		assert.strictEqual(moveItemInData(data, data.items[0], G("外部", [])), false);
	});
});

/* ------------------------------------------------------------------ */
/* applyMoveToGroupChoice（「移动到分组…」菜单路径）                     */
/* ------------------------------------------------------------------ */

describe("applyMoveToGroupChoice（「移动到分组…」菜单路径）", () => {
	test("选择「（顶层）」（target=null）→ 移到根 items 末尾", () => {
		const data = NEW_DATA();
		const b = data.items[1].items[0];
		const ok = applyMoveToGroupChoice(data, b, null, () => () => false);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(names(data.items[1].items), ["G2"]);
		assert.deepStrictEqual(names(data.items), ["a.md", "G1", "d.md", "b.md"]);
	});

	test("选择分组 → 移入该分组（目标在数据中，身份命中）", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const g2 = data.items[1].items[1];
		const ok = applyMoveToGroupChoice(data, a, g2, () => () => false);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
		assert.deepStrictEqual(names(data.items[0].items[1].items), ["c.md", "a.md"]); // a 追加进 G2
	});

	test("目标分组引用失效（file 模式重读）→ 按 key 兜底定位", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const ghost = G("G2"); // 同 title 的新对象，不在 data 中
		const key = (g) => (it) => it.type === "group" && it.title === g.title;
		const ok = applyMoveToGroupChoice(data, a, ghost, key);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
		assert.deepStrictEqual(names(data.items[0].items[1].items), ["c.md", "a.md"]); // 命中真实 G2
	});

	test("目标分组无法定位 → 不修改", () => {
		const data = NEW_DATA();
		const before = JSON.stringify(data);
		const ok = applyMoveToGroupChoice(data, data.items[0], G("不存在"), () => () => false);
		assert.strictEqual(ok, false);
		assert.strictEqual(JSON.stringify(data), before);
	});

	test("legacy 分组条目选「（顶层）」→ 顶层即 data.groups，留在其中", () => {
		const data = LEGACY_DATA();
		const g2 = data.groups[1];
		const ok = applyMoveToGroupChoice(data, g2, null, () => () => false);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(data.groups.map((g) => g.id), ["g1", "g2"]);
	});
});

/* ------------------------------------------------------------------ */
/* removeItemFromData / renameItemInData                               */
/* ------------------------------------------------------------------ */

describe("removeItemFromData", () => {
	test("顶层删除", () => {
		const data = NEW_DATA();
		assert.strictEqual(removeItemFromData(data, data.items[0]), true);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
	});

	test("分组内删除", () => {
		const data = NEW_DATA();
		const b = data.items[1].items[0];
		assert.strictEqual(removeItemFromData(data, b), true);
		assert.deepStrictEqual(names(data.items[1].items), ["G2"]);
	});

	test("旧形状 groups 内删除", () => {
		const data = LEGACY_DATA();
		const b = data.groups[0].items[0];
		assert.strictEqual(removeItemFromData(data, b), true);
		assert.deepStrictEqual(itemPaths(data.groups[0].items), []);
	});

	test("旧形状：删除 legacy 分组条目", () => {
		const data = LEGACY_DATA();
		const g1 = data.groups[0];
		assert.strictEqual(removeItemFromData(data, g1), true);
		assert.deepStrictEqual(data.groups.map((g) => g.id), ["g2"]);
	});

	test("不存在 no-op", () => {
		const data = NEW_DATA();
		const before = JSON.stringify(data);
		assert.strictEqual(removeItemFromData(data, F("ghost.md")), false);
		assert.strictEqual(JSON.stringify(data), before);
	});
});

describe("renameItemInData", () => {
	test("改 title 保留其他字段", () => {
		const data = NEW_DATA();
		const item = data.items[0];
		renameItemInData(item, "新标题");
		assert.strictEqual(item.title, "新标题");
		assert.strictEqual(item.path, "a.md");
		assert.strictEqual(item.ctime, 1);
	});
});

/* ------------------------------------------------------------------ */
/* validateBookmarksData                                               */
/* ------------------------------------------------------------------ */

describe("validateBookmarksData", () => {
	test("合法新形状", () => {
		assert.strictEqual(validateBookmarksData(NEW_DATA()).ok, true);
	});

	test("合法旧形状", () => {
		assert.strictEqual(validateBookmarksData(LEGACY_DATA()).ok, true);
	});

	test("items 非数组", () => {
		const v = validateBookmarksData({ items: "nope" });
		assert.strictEqual(v.ok, false);
		assert.ok(v.errors.some((e) => e.includes("items")));
	});

	test("type 非法", () => {
		const v = validateBookmarksData({ items: [{ type: "widget" }] });
		assert.strictEqual(v.ok, false);
		assert.ok(v.errors.some((e) => e.includes("type 非法")));
	});

	test("group.items 缺失", () => {
		const v = validateBookmarksData({ items: [{ type: "group", title: "G" }] });
		assert.strictEqual(v.ok, false);
		assert.ok(v.errors.some((e) => e.includes("items 数组")));
	});

	test("非对象输入", () => {
		assert.strictEqual(validateBookmarksData(null).ok, false);
		assert.strictEqual(validateBookmarksData([]).ok, false);
	});
});

/* ------------------------------------------------------------------ */
/* parseBookmarksFile（文件兜底解析：合法空文件 → 空数据）              */
/* ------------------------------------------------------------------ */

describe("parseBookmarksFile", () => {
	test("合法空文件 {\"items\":[]} → 空数据（渲染「暂无书签」而非报错）", () => {
		assert.deepStrictEqual(parseBookmarksFile('{"items":[]}'), { items: [], groups: [] });
	});

	test("正常文件 → 解析出 items/groups", () => {
		const data = parseBookmarksFile(JSON.stringify(NEW_DATA()));
		assert.deepStrictEqual(names(data.items), ["a.md", "G1", "d.md"]);
		assert.deepStrictEqual(data.groups, []);
	});

	test("缺 items/groups 数组（{} / null / 空串 / 非 JSON）→ null", () => {
		assert.strictEqual(parseBookmarksFile("{}"), null);
		assert.strictEqual(parseBookmarksFile("null"), null);
		assert.strictEqual(parseBookmarksFile(""), null);
		assert.strictEqual(parseBookmarksFile("not json"), null);
	});

	test("仅 groups 数组（旧形状空文件）→ 空数据", () => {
		assert.deepStrictEqual(parseBookmarksFile('{"groups":[]}'), { items: [], groups: [] });
	});
});

/* ------------------------------------------------------------------ */
/* cloneBookmarksData / restoreData                                    */
/* ------------------------------------------------------------------ */

describe("cloneBookmarksData", () => {
	test("深拷贝：改副本不影响原件", () => {
		const data = NEW_DATA();
		const clone = cloneBookmarksData(data);
		clone.items[0].title = "改了";
		clone.items[1].items.push(F("new.md"));
		assert.notStrictEqual(clone.items[1], data.items[1]); // 嵌套数组独立
		assert.strictEqual(data.items[0].title, undefined);
		assert.strictEqual(data.items[1].items.length, 2);
	});
});

describe("restoreData", () => {
	test("回滚后与原数据一致", () => {
		const data = NEW_DATA();
		const backup = cloneBookmarksData(data);
		data.items.splice(0, 1);
		data.items[0].items.splice(0, 2);
		restoreData(data, backup);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(data)), JSON.parse(JSON.stringify(backup)));
	});
});

/* ------------------------------------------------------------------ */
/* mapNodesToRaw                                                       */
/* ------------------------------------------------------------------ */

describe("mapNodesToRaw", () => {
	/** Mirror of the mock vault in tree.test.cjs (shared reference lookup). */
	class MockVault {
		constructor(map) {
			this.map = map;
		}
		getAbstractFileByPath(input) {
			if (input == null) return null;
			const key = String(input).toLowerCase();
			for (const [p, v] of this.map) {
				if (p.toLowerCase() === key) return v;
			}
			return null;
		}
	}
	const buildVault = (spec) => {
		const objects = new Map();
		const ensureFolder = (p) => {
			if (p === "" || objects.has(p)) return;
			const segments = p.split("/");
			objects.set(p, { path: p, name: segments[segments.length - 1], children: [] });
		};
		for (const raw of spec) {
			const isFolderSpec = raw.endsWith("/");
			const p = isFolderSpec ? raw.slice(0, -1) : raw;
			let idx = p.indexOf("/");
			while (idx !== -1) {
				ensureFolder(p.slice(0, idx));
				idx = p.indexOf("/", idx + 1);
			}
			const name = p.split("/").pop();
			if (isFolderSpec) ensureFolder(p);
			else {
				const dot = name.lastIndexOf(".");
				const basename = dot > 0 ? name.slice(0, dot) : name;
				const extension = dot > 0 ? name.slice(dot + 1) : "";
				objects.set(p, { path: p, name, basename, extension });
			}
		}
		for (const [p, obj] of objects) {
			if (!Array.isArray(obj.children)) continue;
			for (const [cp, child] of objects) {
				if (cp === p) continue;
				const parentDir = cp.includes("/") ? cp.slice(0, cp.lastIndexOf("/")) : "";
				if (parentDir === p) obj.children.push(child);
			}
		}
		return new MockVault(objects);
	};

	test("映射渲染节点 → 原始书签项（含去重跳过）", () => {
		const vault = buildVault(["a/", "a/1.md", "x.md"]);
		const data = { items: [D("a"), F("a/1.md"), F("x.md")], groups: [] };
		const nodes = buildTree(data, vault);
		assert.deepStrictEqual(nodes.map((n) => n.kind), ["folder", "file"]);
		const map = mapNodesToRaw(nodes, data, vault);
		assert.strictEqual(map.size, 2);
		assert.strictEqual(map.get(nodes[0]).path, "a");
		assert.strictEqual(map.get(nodes[1]).path, "x.md");
	});

	test("嵌套分组映射（含旧形状 groups）", () => {
		const vault = buildVault(["n.md"]);
		const data = { items: [G("G1", [F("n.md")])], groups: [{ id: "g1", title: "LG", items: [F("n.md")] }] };
		const nodes = buildTree(data, vault);
		const map = mapNodesToRaw(nodes, data, vault);
		assert.strictEqual(map.size, 4); // G1, n.md(in G1), LG, n.md(in LG)
		assert.strictEqual(map.get(nodes[0]).title, "G1");
		assert.strictEqual(map.get(nodes[0].children[0]).path, "n.md");
		assert.strictEqual(map.get(nodes[1]).id, "g1");
		assert.strictEqual(map.get(nodes[1].children[0]).path, "n.md");
	});

	test("重复书签按位置映射", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = { items: [D("a"), D("a")], groups: [] };
		const nodes = buildTree(data, vault);
		assert.strictEqual(nodes.length, 2);
		const map = mapNodesToRaw(nodes, data, vault);
		assert.strictEqual(map.get(nodes[0]), data.items[0]);
		assert.strictEqual(map.get(nodes[1]), data.items[1]);
	});
});

/* ------------------------------------------------------------------ */
/* isGroupContainer / groupContains                                    */
/* ------------------------------------------------------------------ */

describe("结构守卫", () => {
	test("isGroupContainer：新形状 group / legacy 条目", () => {
		assert.strictEqual(isGroupContainer(G("G", [])), true);
		assert.strictEqual(isGroupContainer({ id: "g", title: "G", items: [] }), true);
		assert.strictEqual(isGroupContainer(F("a.md")), false);
		assert.strictEqual(isGroupContainer(null), false);
		assert.strictEqual(isGroupContainer("x"), false);
	});

	test("groupContains：祖先含后代 / 不含", () => {
		const c = F("c.md");
		const g2 = G("G2", [c]);
		const g1 = G("G1", [F("b.md"), g2]);
		assert.strictEqual(groupContains(g1, g2), true);
		assert.strictEqual(groupContains(g1, c), true);
		const other = G("O", []);
		assert.strictEqual(groupContains(g1, other), false);
		assert.strictEqual(groupContains(g2, g1), false);
	});
});

/* ------------------------------------------------------------------ */
/* Adapters (mock instance / mock adapter)                             */
/* ------------------------------------------------------------------ */

function mockInstance(items) {
	const inst = { items };
	inst.onItemsChangedCalls = [];
	inst.onItemsChanged = (shouldSave) => inst.onItemsChangedCalls.push(shouldSave);
	return inst;
}

function mockAdapter(initialContent) {
	const files = new Map();
	if (initialContent !== undefined) files.set(".obsidian/bookmarks.json", initialContent);
	const adapter = {
		read: async (p) => {
			if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
			return files.get(p);
		},
		write: async (p, s) => {
			files.set(p, s);
		},
		copy: async (p, d) => {
			if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
			files.set(d, files.get(p));
		},
	};
	adapter.files = files;
	return adapter;
}

describe("commitWrite（实例主路径）", () => {
	test("成功：mutate + onItemsChanged(true)", async () => {
		const data = NEW_DATA();
		const inst = mockInstance(data.items);
		const source = { mode: "instance", data, instance: inst, adapter: null, filePath: ".obsidian/bookmarks.json" };
		const r = await commitWrite(source, (d) => removeItemFromData(d, d.items[0]));
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(inst.onItemsChangedCalls, [true]);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
	});

	test("被拒：mutate 返回 false → 不持久化", async () => {
		const data = NEW_DATA();
		const inst = mockInstance(data.items);
		const source = { mode: "instance", data, instance: inst, adapter: null, filePath: "x" };
		const r = await commitWrite(source, () => false);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, "rejected");
		assert.deepStrictEqual(inst.onItemsChangedCalls, []);
	});

	test("mutate 抛错 → 回滚", async () => {
		const data = NEW_DATA();
		const inst = mockInstance(data.items);
		const source = { mode: "instance", data, instance: inst, adapter: null, filePath: "x" };
		const r = await commitWrite(source, (d) => {
			d.items.splice(0, 1); // 部分修改
			throw new Error("boom");
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, "mutate-error");
		assert.deepStrictEqual(names(data.items), ["a.md", "G1", "d.md"]); // 已还原
		assert.deepStrictEqual(inst.onItemsChangedCalls, []);
	});
});

describe("applyToFile / commitWrite（文件兜底路径）", () => {
	test("成功：备份 → 写 → 重读校验", async () => {
		const adapter = mockAdapter(JSON.stringify(NEW_DATA()));
		const data = NEW_DATA();
		removeItemFromData(data, data.items[0]);
		const r = await applyToFile(adapter, data);
		assert.strictEqual(r.ok, true);
		assert.ok(adapter.files.has(".obsidian/bookmarks.json.bak-phb"));
		const reread = JSON.parse(adapter.files.get(".obsidian/bookmarks.json"));
		assert.deepStrictEqual(names(reread.items), ["G1", "d.md"]);
	});

	test("形状非法 → 拒绝写入且不改文件", async () => {
		const adapter = mockAdapter(JSON.stringify({ items: [] }));
		const bad = { items: "nope" };
		const r = await applyToFile(adapter, bad);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, "invalid-data");
		assert.deepStrictEqual(JSON.parse(adapter.files.get(".obsidian/bookmarks.json")), { items: [] });
	});

	test("写失败 → 从备份还原", async () => {
		const adapter = mockAdapter(JSON.stringify({ items: [F("a.md")] }));
		const originalWrite = adapter.write;
		adapter.write = async (p, s) => {
			if (p === ".obsidian/bookmarks.json") throw new Error("disk full");
			return originalWrite(p, s);
		};
		const data = { items: [F("a.md"), F("b.md")], groups: [] };
		const r = await applyToFile(adapter, data);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, "write-failed");
		assert.deepStrictEqual(itemPaths(JSON.parse(adapter.files.get(".obsidian/bookmarks.json")).items), ["a.md"]);
	});

	test("commitWrite 文件模式：写后 loadData 重同步", async () => {
		const adapter = mockAdapter(JSON.stringify(LEGACY_DATA()));
		const data = LEGACY_DATA();
		removeItemFromData(data, data.items[0]);
		const inst = { loadDataCalls: 0, loadData: async () => (inst.loadDataCalls++) };
		const source = { mode: "file", data, instance: inst, adapter, filePath: ".obsidian/bookmarks.json" };
		const r = await commitWrite(source, (d) => removeItemFromData(d, d.groups[0].items[0]));
		assert.strictEqual(r.ok, true);
		assert.strictEqual(inst.loadDataCalls, 1);
		const reread = JSON.parse(adapter.files.get(".obsidian/bookmarks.json"));
		assert.deepStrictEqual(itemPaths(reread.groups[0].items), []);
		// 旧形状保持（groups 数组仍在）
		assert.ok(Array.isArray(reread.groups));
	});
});
