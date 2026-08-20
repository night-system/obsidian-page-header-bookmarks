/* ------------------------------------------------------------------ */
/* Mock tests for src/tree.ts (pure logic — no obsidian import).        */
/*                                                                     */
/* Run:   node --test tests/                                           */
/*                                                                     */
/* The tree module is bundled to CJS first (tests/.tmp/tree.cjs) so     */
/* plain Node can require it:                                          */
/*   npx esbuild src/tree.ts --bundle --format=cjs --platform=node \    */
/*     --outfile=tests/.tmp/tree.cjs                                   */
/* The file auto-rebuilds the bundle below if it is missing or stale,   */
/* so the suite also works from a fresh checkout (tests/.tmp/ is        */
/* gitignored).                                                        */
/* ------------------------------------------------------------------ */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/* ------------------------------------------------------------------ */
/* Ensure the tree.ts bundle exists (tests/.tmp/tree.cjs).             */
/* ------------------------------------------------------------------ */

const ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(__dirname, ".tmp");
const BUNDLE = path.join(TMP_DIR, "tree.cjs");
const SRC = path.join(ROOT, "src", "tree.ts");

function needsRebuild() {
	if (!fs.existsSync(BUNDLE)) return true;
	try {
		return fs.statSync(SRC).mtimeMs > fs.statSync(BUNDLE).mtimeMs;
	} catch {
		return true;
	}
}

if (needsRebuild()) {
	fs.mkdirSync(TMP_DIR, { recursive: true });
	// esbuild's JS API spawns its native service with piped stdio, which
	// sandboxed environments block (EPERM); run the CLI shim instead (same
	// binary, stdio inherited) — equivalent to:
	//   npx esbuild src/tree.ts --bundle --format=cjs --platform=node \
	//     --outfile=tests/.tmp/tree.cjs
	const { execFileSync } = require("node:child_process");
	const esbuildBin = path.join(path.dirname(require.resolve("esbuild")), "..", "bin", "esbuild");
	execFileSync(
		process.execPath,
		[esbuildBin, SRC, "--bundle", "--format=cjs", "--platform=node", `--outfile=${BUNDLE}`, "--log-level=warning"],
		{ stdio: "inherit" }
	);
}

const tree = require(BUNDLE);
const {
	buildTree,
	dedupeTree,
	computeCovered,
	isCovered,
	collectFolderExpansion,
	collectFolderBookmarks,
	normalizePathForCompare,
	isFileLike,
	isFolderLike,
	itemToNode,
} = tree;

/* ------------------------------------------------------------------ */
/* Mock vault                                                          */
/* ------------------------------------------------------------------ */

/**
 * Simulates obsidian's file map: getAbstractFileByPath returns the SAME
 * cached object for the same resolved path (shared references), with two
 * lookup modes:
 *   - caseInsensitive=true  → Windows-style tolerant lookup;
 *   - caseInsensitive=false → Linux-style exact lookup;
 *   - normalizeNFC=true     → optional Unicode-normalizing lookup.
 */
class MockVault {
	constructor(map, caseInsensitive = true, normalizeNFC = false) {
		this.map = map; // Map<canonical path, object>
		this.caseInsensitive = caseInsensitive;
		this.normalizeNFC = normalizeNFC;
	}

	getAbstractFileByPath(input) {
		if (input == null) return null;
		let key = String(input);
		if (this.normalizeNFC) key = key.normalize("NFC");
		if (this.caseInsensitive) key = key.toLowerCase();
		for (const [p, v] of this.map) {
			let pk = p;
			if (this.normalizeNFC) pk = pk.normalize("NFC");
			if (this.caseInsensitive) pk = pk.toLowerCase();
			if (pk === key) return v;
		}
		return null;
	}
}

/**
 * Build a vault from a spec of paths; trailing "/" marks a folder.
 * Parent folders are created implicitly (like a real vault). Objects are
 * shape-compatible with TFile (path/name/basename/extension) and TFolder
 * (path/name/children).
 */
function buildVault(spec) {
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
		if (isFolderSpec) {
			ensureFolder(p);
		} else {
			const dot = name.lastIndexOf(".");
			const basename = dot > 0 ? name.slice(0, dot) : name;
			const extension = dot > 0 ? name.slice(dot + 1) : "";
			objects.set(p, { path: p, name, basename, extension });
		}
	}
	// Wire children (shared references).
	for (const [p, obj] of objects) {
		if (!Array.isArray(obj.children)) continue;
		for (const [cp, child] of objects) {
			if (cp === p) continue;
			const parentDir = cp.includes("/") ? cp.slice(0, cp.lastIndexOf("/")) : "";
			if (parentDir === p) obj.children.push(child);
		}
		obj.children.sort((a, b) => a.path.localeCompare(b.path));
	}
	return new MockVault(objects);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Bookmark item shortcuts (title left undefined → derived from vault). */
const F = (p) => ({ type: "file", path: p }); // file bookmark
const D = (p) => ({ type: "folder", path: p }); // folder bookmark

/**
 * Serialize a tree to indented "kind title path [id=...]" lines so
 * assertions are exact on structure, not just "no duplicates".
 */
function treeLines(nodes, depth = 0) {
	const lines = [];
	for (const n of nodes) {
		const pathPart = n.path ? ` ${n.path}` : "";
		const idPart = n.id != null ? ` id=${n.id}` : "";
		lines.push(`${"  ".repeat(depth)}${n.kind} ${n.title}${pathPart}${idPart}`);
		if (Array.isArray(n.children)) lines.push(...treeLines(n.children, depth + 1));
	}
	return lines;
}

/**
 * Expand a folder node against the vault — mirrors main.ts childrenOf()
 * (lazy vault expansion + folders-first, numeric-aware sort).
 */
function expandFolder(node, vault) {
	if (node.kind !== "folder") return [];
	const folder = vault.getAbstractFileByPath(node.path);
	if (!isFolderLike(folder)) return [];
	const kids = [];
	for (const child of folder.children) {
		if (isFileLike(child)) kids.push({ kind: "file", title: child.basename, path: child.path });
		else if (isFolderLike(child)) kids.push({ kind: "folder", title: child.name, path: child.path });
	}
	kids.sort((a, b) => {
		if (a.kind === "folder" && b.kind !== "folder") return -1;
		if (a.kind !== "folder" && b.kind === "folder") return 1;
		return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
	});
	return kids;
}

const EMPTY_DATA = { items: [], groups: [] };

/* ------------------------------------------------------------------ */
/* Unit tests: normalization + structural guards                       */
/* ------------------------------------------------------------------ */

describe("normalizePathForCompare", () => {
	test("反斜杠 → 正斜杠", () => {
		assert.strictEqual(normalizePathForCompare("a\\b\\c.md"), "a/b/c.md");
	});
	test("双斜杠折叠", () => {
		assert.strictEqual(normalizePathForCompare("a//b///c.md"), "a/b/c.md");
	});
	test("去掉 ./ 段与前导 ./", () => {
		assert.strictEqual(normalizePathForCompare("a/./b"), "a/b");
		assert.strictEqual(normalizePathForCompare("./a/b"), "a/b");
		assert.strictEqual(normalizePathForCompare("a/././b"), "a/b");
	});
	test("去掉首尾斜杠（含尾随斜杠）", () => {
		assert.strictEqual(normalizePathForCompare("a/b/"), "a/b");
		assert.strictEqual(normalizePathForCompare("/a/b"), "a/b");
		assert.strictEqual(normalizePathForCompare("/a/b/"), "a/b");
	});
	test("空白修剪与空路径", () => {
		assert.strictEqual(normalizePathForCompare("  a/b  "), "a/b");
		assert.strictEqual(normalizePathForCompare(""), "");
	});
	test("Unicode NFC 归一化（NFD → NFC）", () => {
		const nfd = "notes/cafe\u0301.md"; // NFD
		const nfc = "notes/caf\u00E9.md"; // NFC
		assert.strictEqual(normalizePathForCompare(nfd), nfc);
		assert.strictEqual(normalizePathForCompare(nfc), nfc);
	});
	test("幂等：对已归一化路径再归一化不变", () => {
		const once = normalizePathForCompare("a//b/./c.md/");
		assert.strictEqual(normalizePathForCompare(once), once);
	});
	test("不引入 lowercase（大小写由对象同一性处理）", () => {
		assert.strictEqual(normalizePathForCompare("A/B.md"), "A/B.md");
	});
});

describe("结构守卫 isFileLike / isFolderLike", () => {
	test("TFile 形状 → isFileLike true", () => {
		assert.strictEqual(isFileLike({ path: "a.md", name: "a.md", basename: "a", extension: "md" }), true);
	});
	test("TFolder 形状 → isFolderLike true，isFileLike false", () => {
		const folder = { path: "a", name: "a", children: [] };
		assert.strictEqual(isFolderLike(folder), true);
		assert.strictEqual(isFileLike(folder), false);
	});
	test("null / undefined / 原始值 → false", () => {
		assert.strictEqual(isFolderLike(null), false);
		assert.strictEqual(isFileLike(undefined), false);
		assert.strictEqual(isFolderLike("a"), false);
		assert.strictEqual(isFileLike(42), false);
	});
});

/* ------------------------------------------------------------------ */
/* 方案 A：computeCovered / isCovered                                   */
/* ------------------------------------------------------------------ */

describe("方案 A：computeCovered / isCovered", () => {
	test("computeCovered 收集对象引用 + 归一化路径（含递归子文件夹）", () => {
		const vault = buildVault(["a/", "a/b/", "a/b/c.md", "a/1.md", "x/", "x/y.md"]);
		const covered = computeCovered({ items: [D("a")], groups: [] }, vault);
		assert.strictEqual(covered.objects.size, 3); // b, c.md, 1.md
		assert.deepStrictEqual([...covered.paths].sort(), ["a/1.md", "a/b", "a/b/c.md"]);
		// x/y.md 不在覆盖集
		assert.strictEqual(isCovered(covered, F("x/y.md"), vault), false);
	});
	test("isCovered：对象同一性优先，归一化字符串兜底", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const covered = computeCovered({ items: [D("a")], groups: [] }, vault);
		assert.strictEqual(isCovered(covered, F("A/1.md"), vault), true); // 对象同一性（大小写）
		assert.strictEqual(isCovered(covered, F("a//1.md"), vault), true); // 字符串兜底（斜杠）
		assert.strictEqual(isCovered(covered, F("other.md"), vault), false);
		assert.strictEqual(isCovered(covered, { type: "search", query: "q" }, vault), false); // 非 file/folder
		assert.strictEqual(isCovered(covered, D("a"), vault), false); // 文件夹书签自身不被覆盖
	});
	test("collectFolderBookmarks 递归覆盖 group 内嵌与旧形状 groups", () => {
		const data = {
			items: [
				D("a"),
				{ type: "group", title: "G", items: [D("b"), { type: "group", title: "G2", items: [D("c")] }] },
			],
			groups: [{ id: "g1", title: "G3", items: [D("d")] }],
		};
		assert.deepStrictEqual(collectFolderBookmarks(data).map((f) => f.path), ["a", "b", "c", "d"]);
	});
});

/* ------------------------------------------------------------------ */
/* 方案 A：buildTree 建树期拦截（14 个用例）                            */
/* ------------------------------------------------------------------ */

describe("方案 A：buildTree 建树期去重（用例 1–14）", () => {
	test("1 标准场景（用户原述）：folder a + 无缩进文件1/2 全部被去重", () => {
		const vault = buildVault(["a/", "a/文件1.md", "a/文件2.md"]);
		const data = { items: [D("a"), F("a/文件1.md"), F("a/文件2.md")], groups: [] };
		const nodes = buildTree(data, vault);
		// 树中无独立 file 节点；顶层节点数 = 1
		assert.deepStrictEqual(treeLines(nodes), ["folder a a"]);
		assert.strictEqual(nodes.length, 1);
		// folder a 展开 children = 2 个文件（vault 真实内容，缩进正确；标题为 basename）
		assert.deepStrictEqual(treeLines(expandFolder(nodes[0], vault)), [
			"file 文件1 a/文件1.md",
			"file 文件2 a/文件2.md",
		]);
	});

	test("2 新形状分组内去重：组内 file 书签被删", () => {
		const vault = buildVault(["a/", "a/文件1.md", "a/文件2.md"]);
		const data = {
			items: [{ type: "group", title: "G", items: [D("a"), F("a/文件1.md"), F("a/文件2.md")] }],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["group G", "  folder a a"]);
	});

	test("3 旧形状 groups 数组去重", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		const data = {
			items: [],
			groups: [{ id: "g1", title: "G", items: [D("a"), F("a/文件1.md")] }],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["group G id=g1", "  folder a a"]);
	});

	test("4 大小写差异（Windows 不敏感 mock）：对象同一性命中，file 被删", () => {
		const vault = buildVault(["a/", "a/文件1.md"]); // caseInsensitive=true（默认）
		const data = { items: [D("A"), F("A/文件1.md")], groups: [] };
		const nodes = buildTree(data, vault);
		// folder 书签 path "A" 解析成功（同一 TFolder 对象）；file 书签被删
		assert.deepStrictEqual(treeLines(nodes), ["folder a A"]);
		// 展开同样正常（大小写不敏感解析）
		assert.deepStrictEqual(treeLines(expandFolder(nodes[0], vault)), ["file 文件1 a/文件1.md"]);
	});

	test("5 尾随斜杠 / 双斜杠 / ./ 路径差异：归一化命中，独立 file 全删", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		const data = {
			items: [D("a"), F("a//文件1.md"), F("a/./文件1.md"), F("a/文件1.md/")],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a a"]);
	});

	test("6 Unicode NFC/NFD 差异：字符串兜底命中（mock 不归一化解析）", () => {
		const vault = buildVault(["notes/", "notes/caf\u00E9.md"]); // NFC canonical
		const data = { items: [D("notes"), F("notes/cafe\u0301.md")], groups: [] }; // NFD bookmark
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder notes notes"]);
	});

	test("6b Unicode NFC/NFD 差异：对象同一性命中（mock 按 NFC 归一化解析）", () => {
		const vault = buildVault(["notes/", "notes/caf\u00E9.md"]);
		vault.normalizeNFC = true; // 模拟 Obsidian 归一化解析 → 同一对象
		const data = { items: [D("notes"), F("notes/cafe\u0301.md")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder notes notes"]);
	});

	test("7 嵌套文件夹覆盖：独立 folder a/b 节点被删，展开 a 可见 b", () => {
		const vault = buildVault(["a/", "a/b/", "a/1.md"]);
		const data = { items: [D("a"), D("a/b")], groups: [] };
		const nodes = buildTree(data, vault);
		assert.deepStrictEqual(treeLines(nodes), ["folder a a"]);
		assert.deepStrictEqual(treeLines(expandFolder(nodes[0], vault)), [
			"folder b a/b",
			"file 1 a/1.md",
		]);
	});

	test("8 文件夹书签在分组内、文件书签在顶层（covered 跨分组生效）", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = {
			items: [{ type: "group", title: "G", items: [D("a")] }, F("a/1.md")],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["group G", "  folder a a"]);
	});

	test("8b 文件夹书签在顶层、文件书签在分组内（反向）", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = {
			items: [D("a"), { type: "group", title: "G", items: [F("a/1.md")] }],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a a", "group G"]);
	});

	test("9 无关书签保留：search / url / graph / 组外文件 / 组内无关文件", () => {
		const vault = buildVault(["a/", "a/1.md", "b/", "b/other.md", "c/", "c/x.md"]);
		const data = {
			items: [
				D("a"),
				F("b/other.md"),
				{ type: "search", title: "s", query: "hello" },
				{ type: "url", title: "u", url: "https://example.com" },
				{ type: "graph", title: "g", options: {} },
				{ type: "group", title: "G", items: [F("c/x.md")] },
			],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), [
			"folder a a",
			"file other b/other.md",
			"search s",
			"url u",
			"graph g",
			"group G",
			"  file x c/x.md",
		]);
	});

	test("10 空分组保留且不可展开", () => {
		const vault = buildVault([]);
		const data = { items: [{ type: "group", title: "empty", items: [] }], groups: [] };
		const nodes = buildTree(data, vault);
		assert.deepStrictEqual(treeLines(nodes), ["group empty"]);
		assert.ok(Array.isArray(nodes[0].children));
		assert.strictEqual(nodes[0].children.length, 0);
		// renderNode 的 hasChildren 判定 → false（点击不展开）
		const hasChildren = nodes[0].kind === "folder" || (nodes[0].children?.length ?? 0) > 0;
		assert.strictEqual(hasChildren, false);
		// 对照：folder 节点 hasChildren 恒为 true（懒加载）
		const v2 = buildVault(["a/", "a/1.md"]);
		const n2 = buildTree({ items: [D("a")], groups: [] }, v2);
		assert.strictEqual(n2[0].kind === "folder" || (n2[0].children?.length ?? 0) > 0, true);
	});

	test("11 嵌套分组（v1.0.4 缺陷修复点）：G2 保留为 G1 内嵌套节点", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = {
			items: [{ type: "group", title: "G1", items: [{ type: "group", title: "G2", items: [D("a")] }] }],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), [
			"group G1",
			"  group G2",
			"    folder a a",
		]);
	});

	test("11b 嵌套分组内去重仍生效", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = {
			items: [
				{
					type: "group",
					title: "G1",
					items: [{ type: "group", title: "G2", items: [D("a"), F("a/1.md")] }],
				},
			],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), [
			"group G1",
			"  group G2",
			"    folder a a",
		]);
	});

	test("12 已删除文件/文件夹书签不显示，不崩溃", () => {
		const vault = buildVault([]);
		const data = { items: [F("ghost/不存在的.md"), D("ghost/")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), []);
		assert.strictEqual(itemToNode(F("ghost/不存在的.md"), vault), null);
		assert.strictEqual(itemToNode(D("ghost/"), vault), null);
	});

	test("13 同路径重复文件夹书签：两条均渲染，不崩溃、不合并", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const data = { items: [D("a"), D("a")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a a", "folder a a"]);
	});

	test("14 大小写敏感模式（caseInsensitive=false）：大小写不同视为不同路径，不误删", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		vault.caseInsensitive = false;
		// 敏感模式下 "A" 解析失败 → 节点不渲染（不是误删，是解析失败被隐藏）
		const data = { items: [D("A"), F("A/文件1.md")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), []);
	});

	test("14b 大小写敏感模式下斜杠/编码类差异仍去重（用例 5 双模式）", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		vault.caseInsensitive = false;
		const data = {
			items: [D("a"), F("a//文件1.md"), F("a/./文件1.md"), F("a/文件1.md/")],
			groups: [],
		};
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a a"]);
	});

	test("14c 大小写敏感模式下嵌套文件夹覆盖仍去重（用例 7 双模式）", () => {
		const vault = buildVault(["a/", "a/b/", "a/1.md"]);
		vault.caseInsensitive = false;
		const data = { items: [D("a"), D("a/b")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a a"]);
	});

	test("14d 大小写不敏感模式（caseInsensitive=true）：大小写差异去重生效（用例 4 双模式）", () => {
		const vault = buildVault(["a/", "a/文件1.md"]); // 默认 true
		const data = { items: [D("A"), F("A/文件1.md")], groups: [] };
		assert.deepStrictEqual(treeLines(buildTree(data, vault)), ["folder a A"]);
	});
});

/* ------------------------------------------------------------------ */
/* 方案 B：dedupeTree 树级后置去重（独立验证）                          */
/* ------------------------------------------------------------------ */

describe("方案 B：dedupeTree 树级后置去重（独立验证）", () => {
	test("B1 pre-filter 漏网兜底：直接注入重复树，dedupeTree 清除独立 file 节点", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		// 模拟「方案 A 判定漏网」：folder 节点 + 独立重复 file 节点
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "file", title: "1", path: "a/1.md" },
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["folder a a"]);
	});

	test("B2 对象引用匹配生效：大小写变体路径被对象同一性删除", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "file", title: "文件1", path: "A/文件1.md" }, // 大小写变体 → 同一对象
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["folder a a"]);
	});

	test("B3 归一化字符串兜底：斜杠变体被删除", () => {
		const vault = buildVault(["a/", "a/文件1.md"]);
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "file", title: "文件1", path: "a//文件1.md" },
			{ kind: "file", title: "文件1b", path: "a/文件1.md/" },
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["folder a a"]);
	});

	test("B4 子文件夹被祖先覆盖时删除（folder 节点自身保留）", () => {
		const vault = buildVault(["a/", "a/b/", "a/b/c.md", "a/1.md"]);
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "folder", title: "b", path: "a/b" },
			{ kind: "file", title: "1", path: "a/1.md" },
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["folder a a"]);
	});

	test("B5 非 file/folder 节点永不参与删除；folder 节点自身不被删", () => {
		const vault = buildVault(["a/", "a/1.md", "b/", "b/other.md"]);
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "file", title: "1", path: "a/1.md" },
			{ kind: "file", title: "other", path: "b/other.md" }, // 不被覆盖 → 保留
			{ kind: "search", title: "s", query: "q" },
			{ kind: "url", title: "u", url: "https://x" },
			{ kind: "graph", title: "g", options: {} },
			{ kind: "group", title: "G", children: [] },
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), [
			"folder a a",
			"file other b/other.md",
			"search s",
			"url u",
			"graph g",
			"group G",
		]);
	});

	test("B6 分组内重复同样被清除（dedupeTree 覆盖 group 递归）", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const raw = [
			{
				kind: "group",
				title: "G",
				children: [
					{ kind: "folder", title: "a", path: "a" },
					{ kind: "file", title: "1", path: "a/1.md" },
				],
			},
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["group G", "  folder a a"]);
	});

	test("B7 collectFolderExpansion 返回对象 + 归一化路径双集合", () => {
		const vault = buildVault(["a/", "a/b/", "a/1.md"]);
		const exp = collectFolderExpansion({ kind: "folder", title: "a", path: "a" }, vault);
		assert.strictEqual(exp.objects.size, 2);
		assert.deepStrictEqual([...exp.paths].sort(), ["a/1.md", "a/b"]);
	});

	test("B8 大小写敏感模式下 dedupeTree 不误删不同路径", () => {
		const vault = buildVault(["a/", "a/1.md", "A/", "A/2.md"]);
		vault.caseInsensitive = false;
		const raw = [
			{ kind: "folder", title: "a", path: "a" },
			{ kind: "file", title: "2", path: "A/2.md" }, // 敏感模式下是不同文件 → 保留
		];
		assert.deepStrictEqual(treeLines(dedupeTree(raw, vault)), ["folder a a", "file 2 A/2.md"]);
	});
});

/* ------------------------------------------------------------------ */
/* buildTree 与 dedupeTree 组合的额外守卫                              */
/* ------------------------------------------------------------------ */

describe("buildTree 组合守卫", () => {
	test("空数据：items/groups 缺失或为空 → 空树，不崩溃", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		assert.deepStrictEqual(treeLines(buildTree({}, vault)), []);
		assert.deepStrictEqual(treeLines(buildTree(EMPTY_DATA, vault)), []);
		assert.deepStrictEqual(treeLines(buildTree(undefined, vault)), []);
	});

	test("建树结果不包含 folder 节点的预展开 children（懒加载保持）", () => {
		const vault = buildVault(["a/", "a/1.md"]);
		const nodes = buildTree({ items: [D("a")], groups: [] }, vault);
		assert.strictEqual(nodes[0].children, undefined);
	});
});
