/* ------------------------------------------------------------------ */
/* Bookmark data write-back — pure logic + thin adapters.              */
/*                                                                     */
/* The pure functions operate on any BookmarksDataLike ({ items }      */
/* tree, plus the legacy { groups } array), mutating it in place, so   */
/* they are unit-testable under plain Node (see tests/writeback.test   */
/* .cjs). The adapters (applyToFile / commitWrite) are the only code   */
/* that touches the filesystem / the core bookmarks instance, and are  */
/* kept thin: every write is 备份 → 校验 → 写 → 重读校验 → 失败回滚.   */
/* ------------------------------------------------------------------ */

import {
	collectFolderExpansion,
	computeCovered,
	isCovered,
	itemToNode,
	normalizePathForCompare,
} from "./tree";
import type { BookmarkItemLike, BookmarksDataLike, TreeNode, VaultLike } from "./tree";

/** Where the core plugin stores its bookmark data (vault-relative). */
export const BOOKMARKS_FILE = ".obsidian/bookmarks.json";

/* ------------------------------------------------------------------ */
/* Structural helpers                                                  */
/* ------------------------------------------------------------------ */

const ITEM_TYPES = new Set(["file", "folder", "search", "url", "graph", "group"]);

/**
 * A "group container" is either a new-shape group item (`type: "group"`)
 * or a legacy groups-array entry (`{ id, title, items }`, no `type`).
 */
export function isGroupContainer(it: unknown): it is BookmarkItemLike {
	return (
		!!it &&
		typeof it === "object" &&
		Array.isArray((it as { items?: unknown }).items) &&
		((it as { type?: unknown }).type === "group" || (it as { type?: unknown }).type === undefined)
	);
}

/** Does `ancestor` (a group container) contain `candidate` anywhere in its subtree? */
export function groupContains(ancestor: BookmarkItemLike, candidate: BookmarkItemLike): boolean {
	let found = false;
	const rec = (list: BookmarkItemLike[] | undefined): void => {
		if (found || !Array.isArray(list)) return;
		for (const it of list) {
			if (it === candidate) {
				found = true;
				return;
			}
			if (isGroupContainer(it)) rec(it.items);
		}
	};
	rec(ancestor.items);
	return found;
}

/* ------------------------------------------------------------------ */
/* Locating                                                           */
/* ------------------------------------------------------------------ */

export interface LocatedItem {
	item: BookmarkItemLike;
	/** The array the item lives in (root items / a group's items / data.groups). */
	parentList: BookmarkItemLike[];
	index: number;
	/** Ancestor group containers, nearest last; [] = top level. */
	groupPath: BookmarkItemLike[];
	/** True when the item itself is a legacy groups-array entry. */
	legacyGroup: boolean;
}

/**
 * Find the first item matching `key` (DFS: root items first, then the
 * legacy groups array, then items nested inside legacy groups).
 */
export function locateItem(
	data: BookmarksDataLike | null | undefined,
	key: (item: BookmarkItemLike) => boolean
): LocatedItem | null {
	if (!data) return null;
	let result: LocatedItem | null = null;

	const searchList = (list: BookmarkItemLike[] | undefined, groupPath: BookmarkItemLike[]): boolean => {
		if (!Array.isArray(list)) return false;
		for (let i = 0; i < list.length; i++) {
			const it = list[i];
			if (key(it)) {
				result = { item: it, parentList: list, index: i, groupPath, legacyGroup: false };
				return true;
			}
			if (isGroupContainer(it)) {
				const next = [...groupPath, it];
				if (searchList(it.items, next)) return true;
			}
		}
		return false;
	};

	if (searchList(data.items, [])) return result;
	for (let i = 0; i < (data.groups ?? []).length; i++) {
		const g = (data.groups as BookmarkItemLike[])[i];
		if (key(g)) {
			result = { item: g, parentList: data.groups as BookmarkItemLike[], index: i, groupPath: [], legacyGroup: true };
			return result;
		}
		if (searchList(g?.items, [g])) return result;
	}
	return null;
}

/**
 * 0-based ordinal of `target` among the items matching `key`, in the same
 * DFS order locateItem searches (root items → legacy groups → their
 * contents). -1 when `target` is not in the data. Used to re-locate a
 * rendered item after a file re-read loses object identity: with duplicate
 * bookmarks (same path / query / …), the ordinal picks the exact slot
 * instead of always the first match.
 */
export function keyOrdinalOf(
	data: BookmarksDataLike | null | undefined,
	key: (item: BookmarkItemLike) => boolean,
	target: BookmarkItemLike
): number {
	if (!data) return -1;
	let ordinal = 0;
	const searchList = (list: BookmarkItemLike[] | undefined): boolean => {
		if (!Array.isArray(list)) return false;
		for (const it of list) {
			if (key(it)) {
				if (it === target) return true;
				ordinal++;
			}
			if (isGroupContainer(it) && searchList(it.items)) return true;
		}
		return false;
	};
	if (searchList(data.items)) return ordinal;
	for (const g of data.groups ?? []) {
		if (key(g)) {
			if (g === target) return ordinal;
			ordinal++;
		}
		if (searchList(g?.items)) return ordinal;
	}
	return -1;
}

/**
 * Locate the `ordinal`-th item (0-based) matching `key`, in locateItem's
 * DFS order. null when there is no such match. With duplicate bookmarks
 * this is the precise counterpart of keyOrdinalOf after a re-read.
 */
export function locateItemAtOrdinal(
	data: BookmarksDataLike | null | undefined,
	key: (item: BookmarkItemLike) => boolean,
	ordinal: number
): LocatedItem | null {
	if (!data || !(ordinal >= 0)) return null;
	let skipped = 0;
	return locateItem(data, (it) => key(it) && skipped++ >= ordinal);
}

/* ------------------------------------------------------------------ */
/* Groups (for the picker)                                            */
/* ------------------------------------------------------------------ */

export interface GroupEntry {
	group: BookmarkItemLike;
	/** Hierarchical path label, e.g. "A / B / C". */
	label: string;
	depth: number;
	legacy: boolean;
}

/** All groups in DFS order (new-shape groups nested inside `items`, plus the legacy `groups` array). */
export function collectGroups(data: BookmarksDataLike | null | undefined): GroupEntry[] {
	const out: GroupEntry[] = [];
	const rec = (list: BookmarkItemLike[] | undefined, prefix: string[], legacy: boolean): void => {
		for (const it of list ?? []) {
			if (it.type === "group" || (it.type === undefined && Array.isArray(it.items))) {
				const title = it.title ?? "";
				out.push({ group: it, label: [...prefix, title].join(" / "), depth: prefix.length, legacy });
				if (Array.isArray(it.items)) rec(it.items, [...prefix, title], false);
			}
		}
	};
	rec(data?.items, [], false);
	for (const g of data?.groups ?? []) {
		const title = g?.title ?? "";
		out.push({ group: g as unknown as BookmarkItemLike, label: title, depth: 0, legacy: true });
		rec(g?.items, [title], true);
	}
	return out;
}

/**
 * Groups the "move to group" picker may offer: every group except the
 * item itself (when it is a group container) and its descendants.
 */
export function groupChoicesFor(data: BookmarksDataLike | null | undefined, item: BookmarkItemLike | null): GroupEntry[] {
	const all = collectGroups(data);
	if (!item || !isGroupContainer(item)) return all;
	const exclude = new Set<BookmarkItemLike>([item]);
	const rec = (list: BookmarkItemLike[] | undefined): void => {
		for (const it of list ?? []) {
			if (it.type === "group") {
				exclude.add(it);
				rec(it.items);
			}
		}
	};
	rec(item.items);
	return all.filter((e) => !exclude.has(e.group));
}

/** Total number of bookmarks (non-group entries) inside a group's subtree. */
export function countGroupItems(group: BookmarkItemLike): number {
	let n = 0;
	const rec = (list: BookmarkItemLike[] | undefined): void => {
		for (const it of list ?? []) {
			if (isGroupContainer(it)) rec(it.items);
			else n++;
		}
	};
	rec(group.items);
	return n;
}

/* ------------------------------------------------------------------ */
/* Mutations (in place; rejections happen before any mutation)        */
/* ------------------------------------------------------------------ */

/**
 * Move `item` into the list of `target` (a group container) or, when
 * `target` is null, into the root list (top level). `index` is the
 * insertion index within that list; undefined = append.
 *
 * Returns false (no mutation) when the item is not found or when a group
 * would be moved into itself or one of its descendants; legacy group
 * entries can only be reordered at the top level (data.groups).
 */
export function moveItemInData(
	data: BookmarksDataLike | null | undefined,
	item: BookmarkItemLike,
	target: BookmarkItemLike | null,
	index?: number
): boolean {
	if (!data || !item) return false;
	const loc = locateItem(data, (it) => it === item);
	if (!loc) return false;

	if (target !== null) {
		// Target must be a real group container that lives in this data.
		if (!locateItem(data, (it) => it === target)) return false;
		if (!isGroupContainer(target)) return false;
		if (loc.legacyGroup) return false; // legacy group entries stay in data.groups
		if (isGroupContainer(item) && (target === item || groupContains(item, target))) return false;
	} else if (loc.legacyGroup) {
		// Top level for a legacy group entry = the data.groups list.
		const groups = data.groups ?? (data.groups = []);
		let insertAt = index;
		const at = groups.indexOf(loc.item);
		if (at !== -1 && typeof insertAt === "number" && insertAt > at) insertAt--;
		groups.splice(at, 1);
		if (typeof insertAt === "number" && insertAt >= 0) groups.splice(Math.min(insertAt, groups.length), 0, loc.item);
		else groups.push(loc.item);
		return true;
	}

	const targetList = target !== null ? (target.items ?? (target.items = [])) : (data.items ?? (data.items = []));
	let insertAt = index;
	if (loc.parentList === targetList && typeof insertAt === "number" && insertAt > loc.index) insertAt--;
	loc.parentList.splice(loc.index, 1);
	if (typeof insertAt === "number" && insertAt >= 0) targetList.splice(Math.min(insertAt, targetList.length), 0, item);
	else targetList.push(item);
	return true;
}

/**
 * Apply a GroupPickerModal choice (the "move to group" menu path):
 *  - `target === null` ("（顶层）") → move `item` to the root list (append);
 *  - otherwise locate the target group container in `data` by identity,
 *    falling back to `containerKey` when the reference is stale (file
 *    mode re-read), then move `item` into it.
 * Returns false (no mutation) when the target cannot be located or the
 * move is rejected.
 */
export function applyMoveToGroupChoice(
	data: BookmarksDataLike | null | undefined,
	item: BookmarkItemLike,
	target: BookmarkItemLike | null,
	containerKey: (group: BookmarkItemLike) => (it: BookmarkItemLike) => boolean
): boolean {
	if (!data || !item) return false;
	if (target === null) return moveItemInData(data, item, null);
	const byId = locateItem(data, (it) => it === target);
	const container = byId ? byId.item : (locateItem(data, containerKey(target))?.item ?? null);
	if (!container) return false;
	return moveItemInData(data, item, container);
}

/** Remove an item (top level, inside a group, or a legacy group entry). */
export function removeItemFromData(data: BookmarksDataLike | null | undefined, item: BookmarkItemLike): boolean {
	const loc = locateItem(data, (it) => it === item);
	if (!loc) return false;
	loc.parentList.splice(loc.index, 1);
	return true;
}

/** Rename in place; all other fields are untouched. */
export function renameItemInData(item: BookmarkItemLike, newTitle: string): void {
	if (item) item.title = newTitle;
}

/* ------------------------------------------------------------------ */
/* Validation / cloning / rollback                                    */
/* ------------------------------------------------------------------ */

export function validateBookmarksData(data: unknown): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, errors: ["data 不是对象"] };
	}
	const d = data as BookmarksDataLike;
	if (!Array.isArray(d.items)) errors.push("items 必须是数组");
	if (d.groups !== undefined && !Array.isArray(d.groups)) errors.push("groups 必须是数组");

	const checkItems = (list: BookmarkItemLike[] | undefined, where: string): void => {
		if (!Array.isArray(list)) return;
		list.forEach((it, i) => {
			if (!it || typeof it !== "object") {
				errors.push(`${where}[${i}] 不是对象`);
				return;
			}
			const type = it.type;
			if (typeof type !== "string" || !ITEM_TYPES.has(type)) {
				errors.push(`${where}[${i}] type 非法: ${String(type)}`);
				return;
			}
			if (type === "group") {
				if (!Array.isArray(it.items)) errors.push(`${where}[${i}] group 缺少 items 数组`);
				else checkItems(it.items, `${where}[${i}].items`);
			}
		});
	};
	checkItems(d.items, "items");
	(d.groups ?? []).forEach((g, i) => {
		if (!g || typeof g !== "object") {
			errors.push(`groups[${i}] 不是对象`);
			return;
		}
		if (!Array.isArray(g.items)) errors.push(`groups[${i}] 缺少 items 数组`);
		else checkItems(g.items, `groups[${i}].items`);
	});
	return { ok: errors.length === 0, errors };
}

/**
 * Parse the core plugin's bookmarks file content into bookmark data.
 * Returns null when the content is not a valid bookmarks file (missing
 * both `items` and `groups` arrays, or unparseable). An empty-but-legal
 * file (e.g. {"items":[]}) yields empty data — the UI then renders the
 * "暂无书签" guide instead of the "未读取到书签数据" error.
 */
export function parseBookmarksFile(raw: string | null | undefined): BookmarksDataLike | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const p = parsed as { items?: unknown; groups?: unknown };
	if (!Array.isArray(p.items) && !Array.isArray(p.groups)) return null;
	return {
		items: Array.isArray(p.items) ? (p.items as BookmarkItemLike[]) : [],
		groups: Array.isArray(p.groups) ? (p.groups as BookmarkItemLike[]) : [],
	};
}

/** Deep clone (bookmark data is JSON-safe). */
export function cloneBookmarksData(data: BookmarksDataLike | null | undefined): BookmarksDataLike {
	if (!data) return { items: [] };
	return JSON.parse(JSON.stringify(data)) as BookmarksDataLike;
}

/** Replace target's list contents with backup's (rollback after a failed write). */
export function restoreData(target: BookmarksDataLike | null | undefined, backup: BookmarksDataLike): void {
	if (!target) return;
	if (Array.isArray(target.items)) {
		target.items.splice(0, target.items.length, ...(backup.items ?? []));
	} else if (Array.isArray(backup.items)) {
		target.items = [...backup.items];
	}
	if (target.groups || backup.groups) {
		const tg = Array.isArray(target.groups) ? target.groups : (target.groups = []);
		tg.splice(0, tg.length, ...(backup.groups ?? []));
	}
}

/* ------------------------------------------------------------------ */
/* Node → raw item mapping (render-time identity for menu / drag)      */
/* ------------------------------------------------------------------ */

/**
 * Map every rendered tree node back to the raw bookmark item it came
 * from. Mirror of tree.ts buildTree + dedupeTree: items covered by a
 * folder bookmark (方案 A) and file/folder nodes covered by an expanded
 * folder node (方案 B) produce no node, so they are skipped in lockstep.
 * Order is preserved by both passes, so the zip is exact — including
 * duplicate bookmarks (positional match).
 */
export function mapNodesToRaw(
	nodes: TreeNode[],
	data: BookmarksDataLike | null | undefined,
	vault: VaultLike
): Map<TreeNode, BookmarkItemLike> {
	const map = new Map<TreeNode, BookmarkItemLike>();
	if (!data || !vault) return map;

	const flat: TreeNode[] = [];
	{
		const walk = (list: TreeNode[]): void => {
			for (const n of list) {
				flat.push(n);
				if (n.children) walk(n.children);
			}
		};
		walk(nodes);
	}

	// 方案 B covered set, derived from the final tree's folder nodes.
	const coveredB: { objects: Set<unknown>; paths: Set<string> } = { objects: new Set(), paths: new Set() };
	for (const n of flat) {
		if (n.kind === "folder" && n.path) {
			const exp = collectFolderExpansion(n, vault);
			exp.objects.forEach((o) => coveredB.objects.add(o));
			exp.paths.forEach((p) => coveredB.paths.add(p));
		}
	}
	const bDoomed = (n: TreeNode): boolean => {
		if (n.kind !== "file" && n.kind !== "folder") return false;
		if (!n.path) return false;
		const obj = vault.getAbstractFileByPath(n.path);
		return (!!obj && coveredB.objects.has(obj)) || coveredB.paths.has(normalizePathForCompare(n.path));
	};

	const coveredA = computeCovered(data, vault);
	let cursor = 0;
	const assign = (it: BookmarkItemLike): void => {
		if (cursor < flat.length) {
			map.set(flat[cursor], it);
			cursor++;
		}
	};
	const visit = (list: BookmarkItemLike[] | undefined): void => {
		for (const it of list ?? []) {
			if (isCovered(coveredA, it, vault)) continue; // 方案 A
			if (it.type === "group") {
				assign(it);
				visit(it.items);
				continue;
			}
			const n = itemToNode(it, vault);
			if (!n) continue; // unrenderable (deleted file etc.)
			if (bDoomed(n)) continue; // 方案 B
			assign(it);
		}
	};
	visit(data.items);
	for (const g of data.groups ?? []) {
		assign(g as unknown as BookmarkItemLike);
		visit(g?.items);
	}
	return map;
}

/* ------------------------------------------------------------------ */
/* Adapters (thin; not unit-tested beyond mock-adapter checks)         */
/* ------------------------------------------------------------------ */

export interface BookmarksInstanceLike {
	items?: BookmarkItemLike[];
	onItemsChanged?: (shouldSave: boolean) => unknown;
	saveData?: () => unknown;
	loadData?: () => Promise<unknown>;
	getBookmarks?: () => BookmarkItemLike[];
}

export interface FileAdapterLike {
	read?: (path: string) => Promise<string>;
	write?: (path: string, data: string) => Promise<void>;
	copy?: (path: string, dest: string) => Promise<void>;
	exists?: (path: string) => Promise<boolean>;
}

export interface ApplyResult {
	ok: boolean;
	reason?: string;
	error?: unknown;
}

function sameJson(a: string, b: string): boolean {
	try {
		return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
	} catch {
		return false;
	}
}

async function restoreBackup(adapter: FileAdapterLike, filePath: string, backupPath: string): Promise<void> {
	try {
		const bk = await adapter.read?.(backupPath);
		if (typeof bk === "string") await adapter.write?.(filePath, bk);
	} catch {
		/* best effort */
	}
}

/**
 * File fallback write: 备份（.bak-phb）→ 校验形状 → 写（2 空格缩进）→
 * 重读校验 → 失败回滚。`data` must already contain the mutation.
 */
export async function applyToFile(
	adapter: FileAdapterLike | null | undefined,
	data: BookmarksDataLike,
	filePath: string = BOOKMARKS_FILE
): Promise<ApplyResult> {
	if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") {
		return { ok: false, reason: "no-adapter" };
	}
	const v = validateBookmarksData(data);
	if (!v.ok) return { ok: false, reason: "invalid-data", error: v.errors };

	const backupPath = filePath + ".bak-phb";
	let current = "";
	try {
		current = await adapter.read(filePath);
	} catch (e) {
		return { ok: false, reason: "read-failed", error: e };
	}
	try {
		if (typeof adapter.copy === "function") await adapter.copy(filePath, backupPath);
		else await adapter.write(backupPath, current);
	} catch (e) {
		return { ok: false, reason: "backup-failed", error: e };
	}

	const serialized = JSON.stringify(data, null, 2) + "\n";
	try {
		await adapter.write(filePath, serialized);
	} catch (e) {
		await restoreBackup(adapter, filePath, backupPath);
		return { ok: false, reason: "write-failed", error: e };
	}

	try {
		const reread = await adapter.read(filePath);
		if (!sameJson(reread, serialized)) throw new Error("verification mismatch");
	} catch (e) {
		await restoreBackup(adapter, filePath, backupPath);
		return { ok: false, reason: "verify-failed", error: e };
	}
	return { ok: true };
}

export interface WriteSource {
	mode: "instance" | "file";
	data: BookmarksDataLike;
	instance: BookmarksInstanceLike | null;
	adapter: FileAdapterLike | null;
	filePath: string;
}

/**
 * Apply a mutation and persist it:
 *  - instance mode: mutate in place on the live items tree, then
 *    onItemsChanged(true) (saveData() as fallback); file write as last
 *    resort when neither exists. Rollback from a deep clone on any error.
 *  - file mode: applyToFile (backup → write → re-read verify → rollback),
 *    then instance.loadData() to resync the core plugin.
 * `mutate` returns false to reject the operation without persisting
 * (e.g. moving a group into itself).
 */
export async function commitWrite(source: WriteSource, mutate: (data: BookmarksDataLike) => boolean): Promise<ApplyResult> {
	const backup = cloneBookmarksData(source.data);
	if (source.mode === "file") {
		const v = validateBookmarksData(source.data);
		if (!v.ok) return { ok: false, reason: "invalid-data", error: v.errors };
	}
	let accepted = false;
	try {
		accepted = mutate(source.data);
	} catch (e) {
		restoreData(source.data, backup);
		return { ok: false, reason: "mutate-error", error: e };
	}
	if (!accepted) return { ok: false, reason: "rejected" };

	if (source.mode === "instance") {
		const inst = source.instance;
		try {
			let persisted = false;
			if (inst && typeof inst.onItemsChanged === "function") {
				inst.onItemsChanged(true);
				persisted = true;
			} else if (inst && typeof inst.saveData === "function") {
				inst.saveData();
				persisted = true;
			}
			if (!persisted && source.adapter) {
				const r = await applyToFile(source.adapter, source.data, source.filePath);
				if (!r.ok) {
					restoreData(source.data, backup);
					return r;
				}
			}
		} catch (e) {
			restoreData(source.data, backup);
			return { ok: false, reason: "persist-error", error: e };
		}
		return { ok: true };
	}

	try {
		const r = await applyToFile(source.adapter, source.data, source.filePath);
		if (!r.ok) {
			restoreData(source.data, backup);
			return r;
		}
		if (source.instance && typeof source.instance.loadData === "function") {
			try {
				await source.instance.loadData();
			} catch {
				/* resync is best effort */
			}
		}
		return { ok: true };
	} catch (e) {
		restoreData(source.data, backup);
		return { ok: false, reason: "file-error", error: e };
	}
}
