/* ------------------------------------------------------------------ */
/* Bookmark tree building & dedup — pure logic, no obsidian imports.   */
/*                                                                     */
/* Structural (duck-typed) bookmark/vault interfaces keep this module   */
/* unit-testable under plain Node (see tests/tree.test.cjs); the real   */
/* obsidian types satisfy them structurally.                           */
/*                                                                     */
/* Dedup strategy (two layers, same判定口径):                          */
/*   A) build-time interception in buildTree()/isCovered();            */
/*   B) tree-level post pass dedupeTree() as a safety net for any      */
/*      data shape A failed to understand.                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Structural types (shape-compatible with obsidian's bookmark data)   */
/* ------------------------------------------------------------------ */

export interface BookmarkItemLike {
	type?: string;
	title?: string;
	path?: string;
	subpath?: string;
	/** Search bookmarks store their query here. */
	query?: string;
	/** URL bookmarks store the URL here. */
	url?: string;
	/** Graph bookmarks store the saved graph view options here. */
	options?: unknown;
	/** Group bookmarks nest their children here. */
	items?: BookmarkItemLike[];
	id?: string;
}

export interface BookmarkGroupLike {
	id?: string;
	title?: string;
	items?: BookmarkItemLike[];
}

export interface BookmarksDataLike {
	items?: BookmarkItemLike[];
	groups?: BookmarkGroupLike[];
}

/** Minimal vault surface tree.ts needs (satisfied by obsidian's Vault). */
export interface VaultLike {
	getAbstractFileByPath(path: string): unknown;
}

export type NodeKind = "group" | "folder" | "file" | "search" | "url" | "graph";

export interface TreeNode {
	kind: NodeKind;
	title: string;
	path?: string;
	subpath?: string;
	query?: string;
	url?: string;
	options?: unknown;
	id?: string;
	/** Lazily loaded / prebuilt children (groups and folders). */
	children?: TreeNode[];
}

/**
 * A covered set stores two parallel representations of the same paths:
 *   - objects: the resolved vault objects (primary — immune to spelling
 *     differences because getAbstractFileByPath returns the same cached
 *     object for the same resolved path);
 *   - paths:   normalized strings (fallback when either side fails to
 *     resolve).
 */
export interface CoveredSet {
	paths: Set<string>;
	objects: Set<unknown>;
}

/* ------------------------------------------------------------------ */
/* Path normalization (self-contained; no obsidian normalizePath)      */
/* ------------------------------------------------------------------ */

/**
 * Normalize a bookmark path for comparison: backslashes → "/", collapse
 * duplicate slashes, drop "./" segments, trim leading/trailing slashes,
 * and NFC-normalize. Intentionally does NOT lowercase — on case-sensitive
 * vaults "A/file.md" and "a/file.md" are different files, so case is
 * handled by object identity instead (computeCovered/isCovered).
 */
export function normalizePathForCompare(path: string): string {
	let p = String(path ?? "").trim();
	p = p.replace(/\\/g, "/"); // backslashes → forward slashes
	p = p.replace(/\/{2,}/g, "/"); // collapse "//" (and longer runs)
	p = p.replace(/\/\.(?=\/|$)/g, ""); // drop "./" segments
	p = p.replace(/^\.\//, ""); // drop a leading "./"
	p = p.replace(/^\/+|\/+$/g, ""); // trim leading/trailing slashes
	return p.normalize("NFC"); // Unicode normalization (NFC)
}

/* ------------------------------------------------------------------ */
/* Structural guards (duck-typing instead of instanceof)               */
/* ------------------------------------------------------------------ */

/** TFile has string basename + extension (TAbstractFile has path/name). */
export function isFileLike(x: unknown): x is { path: string; name: string; basename: string; extension: string } {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as { basename?: unknown }).basename === "string" &&
		typeof (x as { extension?: unknown }).extension === "string"
	);
}

/** TFolder has an array of children (TAbstractFile has path/name). */
export function isFolderLike(x: unknown): x is { path: string; name: string; children: unknown[] } {
	return (
		!!x &&
		typeof x === "object" &&
		Array.isArray((x as { children?: unknown }).children) &&
		typeof (x as { path?: unknown }).path === "string"
	);
}

/* ------------------------------------------------------------------ */
/* Covered set (方案 A: build-time interception)                       */
/* ------------------------------------------------------------------ */

/**
 * Collect every folder bookmark, recursing into groups (new shape,
 * arbitrary depth) and into the legacy `groups` array (old shape).
 */
export function collectFolderBookmarks(data: BookmarksDataLike): BookmarkItemLike[] {
	const out: BookmarkItemLike[] = [];
	const collect = (it: BookmarkItemLike | undefined): void => {
		if (!it) return;
		if (it.type === "folder" && it.path) out.push(it);
		(it.items ?? []).forEach(collect);
	};
	(data?.items ?? []).forEach(collect);
	for (const g of data?.groups ?? []) (g?.items ?? []).forEach(collect);
	return out;
}

/**
 * Files/folders reachable by expanding any bookmarked folder, including
 * all descendants of subfolders. Unresolvable folder bookmarks just skip
 * their subtree (no crash, no warning).
 */
export function computeCovered(data: BookmarksDataLike, vault: VaultLike): CoveredSet {
	const covered: CoveredSet = { paths: new Set<string>(), objects: new Set<unknown>() };
	const visit = (path: string): void => {
		const folder = vault.getAbstractFileByPath(path);
		if (!isFolderLike(folder)) return; // unresolvable — skip this subtree
		for (const child of folder.children) {
			if (isFileLike(child) || isFolderLike(child)) {
				covered.objects.add(child);
				covered.paths.add(normalizePathForCompare(child.path));
			}
			if (isFolderLike(child)) visit(child.path); // recurse into subfolders
		}
	};
	for (const f of collectFolderBookmarks(data)) if (f.path) visit(f.path);
	return covered;
}

/**
 * Should this file/folder bookmark be hidden because a bookmarked folder
 * covers it? Object identity first (digests any case / Unicode / slash
 * difference the resolver can handle), normalized string as fallback.
 */
export function isCovered(covered: CoveredSet, item: BookmarkItemLike, vault: VaultLike): boolean {
	if (item.type !== "file" && item.type !== "folder") return false;
	if (!item.path) return false;
	// 1) Object identity (primary): the resolved object is a covered object.
	const obj = vault.getAbstractFileByPath(item.path);
	if (obj && covered.objects.has(obj)) return true;
	// 2) Normalized-string fallback.
	return covered.paths.has(normalizePathForCompare(item.path));
}

/* ------------------------------------------------------------------ */
/* Node conversion & tree building                                     */
/* ------------------------------------------------------------------ */

/** Convert one bookmark item into a tree node; null hides it. */
export function itemToNode(it: BookmarkItemLike | undefined, vault: VaultLike): TreeNode | null {
	if (!it) return null;
	const type = it.type;
	if (type === "file") {
		const path = it.path ?? "";
		const file = vault.getAbstractFileByPath(path);
		// Deleted files are hidden, same as the core bookmarks view.
		if (!isFileLike(file)) return null;
		const title = it.title && it.title.trim() ? it.title : file.basename;
		return { kind: "file", title, path, subpath: it.subpath };
	}
	if (type === "folder") {
		const path = it.path ?? "";
		const folder = vault.getAbstractFileByPath(path);
		if (!isFolderLike(folder)) return null;
		const title = it.title && it.title.trim() ? it.title : folder.name;
		return { kind: "folder", title, path };
	}
	if (type === "search") {
		const query = it.query ?? it.path ?? "";
		return { kind: "search", title: it.title || query || "搜索", query, path: it.path ?? "" };
	}
	if (type === "url") {
		return { kind: "url", title: it.title || it.url || "链接", url: it.url ?? "" };
	}
	if (type === "graph") {
		return { kind: "graph", title: it.title || "图谱", options: it.options };
	}
	return null;
}

/**
 * Build the bookmark tree. 方案 A intercepts covered file/folder bookmarks
 * during conversion; group conversion recurses so nested groups (new shape)
 * and the legacy `groups` array (old shape) both work; empty groups are
 * kept. Finally 方案 B (dedupeTree) cleans up whatever A missed.
 */
export function buildTree(data: BookmarksDataLike, vault: VaultLike): TreeNode[] {
	const covered = computeCovered(data, vault);

	const convert = (it: BookmarkItemLike | undefined): TreeNode | null => {
		if (!it) return null;
		if (isCovered(covered, it, vault)) return null; // 方案 A
		if (it.type === "group") {
			const kids = (Array.isArray(it.items) ? it.items : [])
				.map(convert)
				.filter((n): n is TreeNode => n !== null);
			return { kind: "group", title: it.title || "未命名分组", children: kids };
		}
		return itemToNode(it, vault);
	};

	const root: TreeNode[] = [];
	for (const it of data?.items ?? []) {
		const n = convert(it);
		if (n) root.push(n);
	}
	for (const g of data?.groups ?? []) {
		const kids = (g?.items ?? [])
			.map(convert)
			.filter((n): n is TreeNode => n !== null);
		root.push({ kind: "group", id: g?.id, title: g?.title || "未命名分组", children: kids });
	}
	return dedupeTree(root, vault); // 方案 B
}

/* ------------------------------------------------------------------ */
/* 方案 B: tree-level post dedup                                       */
/* ------------------------------------------------------------------ */

/**
 * Expansion (files + folders, recursively) of one rendered folder node.
 * The node's path is already known-resolvable (it rendered), so coverage
 * derived here does not depend on raw bookmark strings vs vault casing.
 */
export function collectFolderExpansion(node: TreeNode, vault: VaultLike): CoveredSet {
	const out: CoveredSet = { paths: new Set<string>(), objects: new Set<unknown>() };
	const visit = (path: string): void => {
		const folder = vault.getAbstractFileByPath(path);
		if (!isFolderLike(folder)) return;
		for (const child of folder.children) {
			if (isFileLike(child) || isFolderLike(child)) {
				out.objects.add(child);
				out.paths.add(normalizePathForCompare(child.path));
			}
			if (isFolderLike(child)) visit(child.path);
		}
	};
	if (node.path) visit(node.path);
	return out;
}

/**
 * Remove standalone file/folder nodes reachable by expanding a folder node
 * already in the tree. Works on any tree (even one 方案 A failed to prune)
 * because coverage is re-derived from the vault, not from bookmark strings.
 * Folder nodes themselves are never deleted (coverage only contains their
 * children); group/search/url/graph nodes never participate. Doomed nodes
 * are collected first, then pruned, to avoid mutating arrays mid-iteration.
 */
export function dedupeTree(root: TreeNode[], vault: VaultLike): TreeNode[] {
	// 1) Collect the expansion of every folder node (objects + paths).
	const covered: CoveredSet = { paths: new Set<string>(), objects: new Set<unknown>() };
	const visitFolder = (nodes: TreeNode[]): void => {
		for (const n of nodes) {
			if (n.kind === "folder") {
				const exp = collectFolderExpansion(n, vault);
				exp.objects.forEach((o) => covered.objects.add(o));
				exp.paths.forEach((p) => covered.paths.add(p));
			}
			if (n.children) visitFolder(n.children); // groups, populated folders
		}
	};
	visitFolder(root);

	// 2) Mark covered standalone file/folder nodes.
	const doomed: TreeNode[] = [];
	const scan = (nodes: TreeNode[]): void => {
		for (const n of nodes) {
			if ((n.kind === "file" || n.kind === "folder") && n.path) {
				const obj = vault.getAbstractFileByPath(n.path);
				if ((obj && covered.objects.has(obj)) || covered.paths.has(normalizePathForCompare(n.path))) {
					doomed.push(n);
				}
			}
			if (n.children) scan(n.children);
		}
	};
	scan(root);
	const drop = new Set(doomed);
	const prune = (nodes: TreeNode[]): TreeNode[] =>
		nodes.filter((n) => !drop.has(n)).map((n) =>
			n.children ? { ...n, children: prune(n.children) } : n
		);
	return prune(root);
}
