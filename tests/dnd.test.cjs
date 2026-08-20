/* ------------------------------------------------------------------ */
/* Mock tests for src/dnd.ts (pure drop geometry / action logic).       */
/*                                                                     */
/* Run:   node --test --test-isolation=none tests/dnd.test.cjs          */
/*                                                                     */
/* Bundles src/dnd.ts → tests/.tmp/dnd.cjs (pulls in writeback+tree).  */
/* The DOM gesture state machine (attachRowDrag) needs a real browser,  */
/* so only the pure functions are unit-tested here.                     */
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
	execFileSync(
		process.execPath,
		[esbuildBin, src, "--bundle", "--format=cjs", "--platform=node", `--outfile=${outfile}`, "--log-level=warning"],
		{ stdio: "inherit" }
	);
}

ensureBundle(path.join(ROOT, "src", "dnd.ts"), path.join(TMP_DIR, "dnd.cjs"));
ensureBundle(path.join(ROOT, "src", "writeback.ts"), path.join(TMP_DIR, "writeback.cjs"));

const dnd = require(path.join(TMP_DIR, "dnd.cjs"));
const {
	computeDropMode,
	needsAutoScroll,
	computeDropAction,
	resolvePointerEnd,
	ClickSuppressor,
	CLICK_SUPPRESS_RESET_MS,
	SCROLL_EDGE,
} = dnd;
const wb = require(path.join(TMP_DIR, "writeback.cjs"));
const { moveItemInData, isGroupContainer } = wb;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const F = (p) => ({ type: "file", ctime: 1, path: p });
const G = (title, items = []) => ({ type: "group", ctime: 1, title, items });

/** a.md, G1 (b.md, G2 (c.md)), d.md — top-level. */
const NEW_DATA = () => ({
	items: [F("a.md"), G("G1", [F("b.md"), G("G2", [F("c.md")])]), F("d.md")],
	groups: [],
});

const LEGACY_DATA = () => ({
	items: [F("a.md")],
	groups: [
		{ id: "g1", title: "G1", items: [F("b.md")] },
		{ id: "g2", title: "G2", items: [] },
	],
});

const names = (items) => items.map((i) => i.path ?? i.title);

/** Apply a DropAction via moveItemInData; returns the final data. */
function apply(data, action, dragItem) {
	assert.strictEqual(action.ok, true);
	const ok = moveItemInData(data, dragItem, action.target, action.index);
	assert.strictEqual(ok, true);
	return data;
}

/* ------------------------------------------------------------------ */
/* computeDropMode                                                     */
/* ------------------------------------------------------------------ */

describe("computeDropMode", () => {
	const rect = { top: 100, height: 100 };

	test("group 行三区：0.1→before / 0.4→into / 0.9→after", () => {
		assert.strictEqual(computeDropMode(rect, 110, true), "before");
		assert.strictEqual(computeDropMode(rect, 140, true), "into");
		assert.strictEqual(computeDropMode(rect, 190, true), "after");
	});

	test("group 行边界：0.25 与 0.75 归入 into（严格 <0.25 才 before，>0.75 才 after）", () => {
		assert.strictEqual(computeDropMode(rect, 125, true), "into"); // y=0.25
		assert.strictEqual(computeDropMode(rect, 175, true), "into"); // y=0.75
		assert.strictEqual(computeDropMode(rect, 124, true), "before"); // y=0.24
		assert.strictEqual(computeDropMode(rect, 176, true), "after"); // y=0.76
	});

	test("非 group 行二区：0.5→before，0.51→after", () => {
		assert.strictEqual(computeDropMode(rect, 150, false), "before");
		assert.strictEqual(computeDropMode(rect, 151, false), "after");
	});

	test("越界 / 非法 rect → null", () => {
		assert.strictEqual(computeDropMode(rect, 99, true), null);
		assert.strictEqual(computeDropMode(rect, 201, false), null);
		assert.strictEqual(computeDropMode({ top: 0, height: 0 }, 10, true), null);
	});
});

/* ------------------------------------------------------------------ */
/* needsAutoScroll                                                     */
/* ------------------------------------------------------------------ */

describe("needsAutoScroll", () => {
	const rect = { top: 0, bottom: 400 };

	test("上边缘内 → up；下边缘内 → down；中间 → null", () => {
		assert.strictEqual(needsAutoScroll(rect, 10), "up");
		assert.strictEqual(needsAutoScroll(rect, SCROLL_EDGE - 1), "up");
		assert.strictEqual(needsAutoScroll(rect, 395), "down");
		assert.strictEqual(needsAutoScroll(rect, 200), null);
	});

	test("自定义 edge", () => {
		assert.strictEqual(needsAutoScroll(rect, 5, 10), "up");
		assert.strictEqual(needsAutoScroll(rect, 15, 10), null);
	});
});

/* ------------------------------------------------------------------ */
/* computeDropAction                                                   */
/* ------------------------------------------------------------------ */

describe("computeDropAction", () => {
	test("before 同列表（源在目标前）：索引修正", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const c = data.items[2];
		const action = computeDropAction(data, a, c, "before");
		assert.deepStrictEqual(action, { ok: true, target: null, index: 2 });
		apply(data, action, a);
		assert.deepStrictEqual(names(data.items), ["G1", "a.md", "d.md"]);
	});

	test("after 同列表（源在目标后）", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const g1 = data.items[1];
		const action = computeDropAction(data, a, g1, "after");
		assert.deepStrictEqual(action, { ok: true, target: null, index: 2 });
		apply(data, action, a);
		assert.deepStrictEqual(names(data.items), ["G1", "a.md", "d.md"]);
	});

	test("before 同列表（源在目标后）：无修正", () => {
		const data = NEW_DATA();
		const d = data.items[2];
		const g1 = data.items[1];
		const action = computeDropAction(data, d, g1, "before");
		assert.deepStrictEqual(action, { ok: true, target: null, index: 1 });
		apply(data, action, d);
		assert.deepStrictEqual(names(data.items), ["a.md", "d.md", "G1"]);
	});

	test("into 分组追加", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const g1 = data.items[1];
		const action = computeDropAction(data, a, g1, "into");
		assert.deepStrictEqual(action, { ok: true, target: g1, index: undefined });
		apply(data, action, a);
		assert.deepStrictEqual(names(data.items), ["G1", "d.md"]);
		assert.deepStrictEqual(names(data.items[0].items), ["b.md", "G2", "a.md"]);
	});

	test("top：移到顶层（列表空白落点）", () => {
		const data = NEW_DATA();
		const b = data.items[1].items[0];
		const action = computeDropAction(data, b, null, "top");
		assert.deepStrictEqual(action, { ok: true, target: null, index: undefined });
		apply(data, action, b);
		assert.deepStrictEqual(names(data.items[1].items), ["G2"]);
		assert.deepStrictEqual(names(data.items), ["a.md", "G1", "d.md", "b.md"]);
	});

	test("目标为自身 → no-op", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const action = computeDropAction(data, a, a, "before");
		assert.strictEqual(action.ok, false);
		assert.strictEqual(action.reason, "self");
	});

	test("group 移入自身后代 → no-op", () => {
		const data = NEW_DATA();
		const g1 = data.items[1];
		const g2 = data.items[1].items[1];
		assert.strictEqual(computeDropAction(data, g1, g2, "into").reason, "group-descendant");
		assert.strictEqual(computeDropAction(data, g1, g2, "before").reason, "group-descendant");
	});

	test("同分组内 into → no-op（已在组内）", () => {
		const data = NEW_DATA();
		const g1 = data.items[1];
		const b = g1.items[0];
		assert.strictEqual(computeDropAction(data, b, g1, "into").reason, "same-container");
	});

	test("空分组目标 into → ok", () => {
		const data = { items: [F("a.md"), G("empty", [])], groups: [] };
		const a = data.items[0];
		const empty = data.items[1];
		const action = computeDropAction(data, a, empty, "into");
		assert.strictEqual(action.ok, true);
		apply(data, action, a);
		assert.deepStrictEqual(names(data.items[0].items), ["a.md"]); // 移入后组成为唯一项
		assert.strictEqual(data.items.length, 1);
	});

	test("非 group 行 into → no-op", () => {
		const data = NEW_DATA();
		const a = data.items[0];
		const b = data.items[1].items[0];
		assert.strictEqual(computeDropAction(data, a, b, "into").reason, "not-group");
	});

	test("拖拽项不在数据中 → no-op", () => {
		const data = NEW_DATA();
		const ghost = F("ghost.md");
		assert.strictEqual(computeDropAction(data, ghost, data.items[0], "before").reason, "not-found");
	});

	test("旧形状：条目移入 legacy 分组", () => {
		const data = LEGACY_DATA();
		const a = data.items[0];
		const g2 = data.groups[1];
		const action = computeDropAction(data, a, g2, "into");
		assert.strictEqual(action.ok, true);
		apply(data, action, a);
		assert.deepStrictEqual(names(data.groups[1].items), ["a.md"]);
	});

	test("旧形状：legacy 分组条目 into → no-op", () => {
		const data = LEGACY_DATA();
		const g2 = data.groups[1];
		const g1 = data.groups[0];
		assert.strictEqual(computeDropAction(data, g2, g1, "into").reason, "legacy-group-into");
	});

	test("旧形状：legacy 分组条目在 groups 内重排", () => {
		const data = LEGACY_DATA();
		const g2 = data.groups[1];
		const g1 = data.groups[0];
		const action = computeDropAction(data, g2, g1, "before");
		assert.strictEqual(action.ok, true);
		apply(data, action, g2);
		assert.deepStrictEqual(data.groups.map((g) => g.id), ["g2", "g1"]);
	});

	test("旧形状：legacy 分组条目 vs 顶层条目 → no-op", () => {
		const data = LEGACY_DATA();
		const g1 = data.groups[0];
		const a = data.items[0];
		assert.strictEqual(computeDropAction(data, g1, a, "before").reason, "legacy-group-cross");
	});

	test("旧形状：普通条目 drop 在 legacy 分组行旁 → 顶层追加", () => {
		const data = { items: [F("a.md")], groups: [{ id: "g1", title: "G1", items: [] }] };
		const a = data.items[0];
		const g1 = data.groups[0];
		const action = computeDropAction(data, a, g1, "after");
		assert.strictEqual(action.ok, true);
		assert.deepStrictEqual(action, { ok: true, target: null, index: undefined });
	});
});

/* ------------------------------------------------------------------ */
/* isGroupContainer (writeback, cross-check)                           */
/* ------------------------------------------------------------------ */

describe("isGroupContainer（跨模块交叉检查）", () => {
	test("group / legacy 条目为容器", () => {
		assert.strictEqual(isGroupContainer(G("G", [])), true);
		assert.strictEqual(isGroupContainer({ id: "g", title: "G", items: [] }), true);
		assert.strictEqual(isGroupContainer(F("a.md")), false);
	});
});

/* ------------------------------------------------------------------ */
/* resolvePointerEnd（pointerup / pointercancel 落点判定）              */
/* ------------------------------------------------------------------ */

describe("resolvePointerEnd", () => {
	test("pointercancel 永不触发 drop（系统手势抢占 / 来电）", () => {
		assert.strictEqual(resolvePointerEnd("cancel", true, { kind: "row", row: {}, mode: "into" }), null);
		assert.strictEqual(resolvePointerEnd("cancel", true, { kind: "empty" }), null);
		assert.strictEqual(resolvePointerEnd("cancel", false, { kind: "row", row: {}, mode: "into" }), null);
	});

	test("pointerup 仅在 active 且落点有效时触发 drop", () => {
		const target = { kind: "row", row: {}, mode: "into" };
		assert.strictEqual(resolvePointerEnd("up", true, target), target);
		assert.strictEqual(resolvePointerEnd("up", true, { kind: "none" }), null);
		assert.strictEqual(resolvePointerEnd("up", false, target), null);
	});
});

/* ------------------------------------------------------------------ */
/* ClickSuppressor（拖拽后点击抑制自动复位）                             */
/* ------------------------------------------------------------------ */

describe("ClickSuppressor（拖拽后点击抑制自动复位）", () => {
	/** Deterministic fake timers injected into ClickSuppressor. */
	function fakeTimers() {
		let now = 0;
		let nextId = 1;
		const pending = new Map();
		return {
			schedule: (fn, ms) => {
				const id = nextId++;
				pending.set(id, { fn, at: now + ms });
				return id;
			},
			cancel: (id) => pending.delete(id),
			advance: (ms) => {
				now += ms;
				const due = [...pending.entries()]
					.filter(([, t]) => t.at <= now)
					.sort((a, b) => a[1].at - b[1].at);
				for (const [id, t] of due) {
					pending.delete(id);
					t.fn();
				}
			},
			pendingCount: () => pending.size,
		};
	}

	test("置位后可消费；消费即复位并取消定时器", () => {
		const t = fakeTimers();
		const s = new ClickSuppressor(CLICK_SUPPRESS_RESET_MS, t.schedule, t.cancel);
		s.setActive(true);
		assert.strictEqual(s.isActive(), true);
		assert.strictEqual(s.consume(), true);
		assert.strictEqual(s.isActive(), false);
		assert.strictEqual(s.consume(), false);
		assert.strictEqual(t.pendingCount(), 0);
	});

	test("未消费的抑制在重置窗口后自动复位（拖拽后下一次点击不被吞）", () => {
		const t = fakeTimers();
		const s = new ClickSuppressor(CLICK_SUPPRESS_RESET_MS, t.schedule, t.cancel);
		s.setActive(true);
		t.advance(CLICK_SUPPRESS_RESET_MS);
		assert.strictEqual(s.isActive(), false);
		assert.strictEqual(s.consume(), false); // 下一次点击正常放行
	});

	test("重置窗口内消费后定时器取消；再次置位重新计时", () => {
		const t = fakeTimers();
		const s = new ClickSuppressor(CLICK_SUPPRESS_RESET_MS, t.schedule, t.cancel);
		s.setActive(true);
		s.consume();
		assert.strictEqual(t.pendingCount(), 0);
		t.advance(CLICK_SUPPRESS_RESET_MS);
		assert.strictEqual(s.isActive(), false);
		s.setActive(true);
		t.advance(CLICK_SUPPRESS_RESET_MS - 1);
		assert.strictEqual(s.isActive(), true);
		t.advance(1);
		assert.strictEqual(s.isActive(), false);
	});

	test("setActive(false) 立即清除抑制与定时器", () => {
		const t = fakeTimers();
		const s = new ClickSuppressor(CLICK_SUPPRESS_RESET_MS, t.schedule, t.cancel);
		s.setActive(true);
		s.setActive(false);
		assert.strictEqual(s.isActive(), false);
		assert.strictEqual(s.consume(), false);
		assert.strictEqual(t.pendingCount(), 0);
	});
});
