import { ItemView, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";

/* ------------------------------------------------------------------ */
/* Core-plugin "Bookmarks" data model (internal, based on decompiled    */
/* types from obsidian-typings for Obsidian 1.13.x).                    */
/* ------------------------------------------------------------------ */

interface BookmarkItem {
	type?: "file" | "folder" | "group" | "search" | "url" | "graph";
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
	items?: BookmarkItem[];
}

interface BookmarkGroup {
	id?: string;
	title?: string;
	items?: BookmarkItem[];
}

interface BookmarksData {
	items: BookmarkItem[];
	groups: BookmarkGroup[];
}

/** Strip leading/trailing slashes so bookmark paths resolve reliably. */
function normalizePath(p: string): string {
	return p.replace(/^\/+|\/+$/g, "");
}

/* ------------------------------------------------------------------ */
/* Icons (Lucide-style inline SVGs)                                    */
/* ------------------------------------------------------------------ */

const ICON_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;
const ICON_SEARCH = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
const ICON_LINK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const ICON_GRAPH = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>`;
const ICON_CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/* ------------------------------------------------------------------ */
/* Tree model                                                          */
/* ------------------------------------------------------------------ */

type NodeKind = "group" | "folder" | "file" | "search" | "url" | "graph";

interface TreeNode {
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

export default class PageHeaderBookmarksPlugin extends Plugin {
	/** Injected page-header buttons, keyed by the view they belong to. */
	private buttons = new WeakMap<ItemView, HTMLElement>();

	private backdrop: HTMLElement | null = null;
	private popover: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private expanded = new Set<string>();

	private keyHandler = (e: KeyboardEvent): void => {
		if (e.key === "Escape") this.closePopover();
	};

	private resizeHandler = (): void => {
		if (this.anchor && this.anchor.isConnected) this.positionPopover();
		else this.closePopover();
	};

	async onload(): Promise<void> {
		this.app.workspace.onLayoutReady(() =>
			window.setTimeout(() => this.addButtonsToAllLeaves(), 100)
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.addButtonsToAllLeaves();
				// The pane holding the popover's anchor button is gone.
				if (this.popover && this.anchor && !this.anchor.isConnected) this.closePopover();
			})
		);

		this.register(() => {
			this.closePopover();
			this.removeButtonsFromAllLeaves();
		});
	}

	/* ------------------------------------------------------------------ */
	/* Page header button — same mechanism as the Commander plugin:        */
	/* ItemView.addAction() (native icon rendering + native button shape), */
	/* ordered left of the "more options" button via CSS `order`.          */
	/* ------------------------------------------------------------------ */

	private addButtonsToAllLeaves(): void {
		window.requestAnimationFrame(() =>
			this.app.workspace.iterateAllLeaves((leaf) => this.addButtonToLeaf(leaf))
		);
	}

	private addButtonToLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof ItemView)) return;
		if (this.buttons.has(view)) return;
		const button = view.addAction("bookmark", "书签", () => {
			this.togglePopover(button);
		});
		button.addClass("phb-button");
		this.buttons.set(view, button);
	}

	private removeButtonsFromAllLeaves(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof ItemView)) return;
			const button = this.buttons.get(view);
			if (button) {
				button.detach();
				this.buttons.delete(view);
			}
		});
	}

	/* ------------------------------------------------------------------ */
	/* Popover lifecycle                                                   */
	/* ------------------------------------------------------------------ */

	private togglePopover(btn: HTMLElement): void {
		if (this.popover && this.anchor === btn) this.closePopover();
		else this.openPopover(btn);
	}

	private openPopover(btn: HTMLElement): void {
		this.closePopover();
		this.anchor = btn;

		// Full-screen transparent backdrop: any click outside the popover
		// lands on it and closes the popover.
		const backdrop = createDiv({ cls: "phb-backdrop" });
		const popover = createDiv({ cls: "phb-popover" });
		document.body.appendChild(backdrop);
		document.body.appendChild(popover);
		this.backdrop = backdrop;
		this.popover = popover;

		const header = popover.createDiv({ cls: "phb-popover-header" });
		header.createSpan({ cls: "phb-popover-title", text: "书签" });
		const closeBtn = header.createEl("button", {
			cls: "phb-close clickable-icon",
			attr: { "aria-label": "关闭" },
		});
		closeBtn.innerHTML = ICON_CLOSE;
		closeBtn.addEventListener("click", (e: MouseEvent) => {
			e.stopPropagation();
			this.closePopover();
		});

		this.listEl = popover.createDiv({ cls: "phb-popover-list" });
		this.expanded.clear();
		void this.renderInto(this.listEl).finally(() => this.positionPopover());

		backdrop.addEventListener("click", () => this.closePopover());
		window.addEventListener("keydown", this.keyHandler);
		window.addEventListener("resize", this.resizeHandler);

		this.positionPopover();
	}

	private closePopover(): void {
		this.backdrop?.remove();
		this.popover?.remove();
		this.backdrop = null;
		this.popover = null;
		this.anchor = null;
		this.listEl = null;
		this.expanded.clear();
		window.removeEventListener("keydown", this.keyHandler);
		window.removeEventListener("resize", this.resizeHandler);
	}

	private positionPopover(): void {
		if (!this.popover || !this.anchor) return;
		const popover = this.popover;
		popover.style.visibility = "hidden";
		const rect = this.anchor.getBoundingClientRect();
		const pw = popover.offsetWidth;
		const ph = popover.offsetHeight;
		let left = rect.left;
		let top = rect.bottom + 6;
		if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
		if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
		popover.style.visibility = "visible";
	}

	/* ------------------------------------------------------------------ */
	/* Data resolution                                                     */
	/* ------------------------------------------------------------------ */

	/**
	 * Fetch bookmark data from every source we know about, newest first:
	 *   1. live instances (`app.bookmarks`, `app.internalPlugins…instance`)
	 *      — items may be ungrouped (old shape) or a unified list that also
	 *      contains `type: "group"` entries with nested items (new shape);
	 *   2. `getBookmarks()` flat list when the instance exposes it;
	 *   3. the core plugin's data file `.obsidian/bookmarks.json` (most
	 *      reliable across versions; read on demand so it is always fresh).
	 */
	private async resolveBookmarks(): Promise<BookmarksData | null> {
		const liveSources: unknown[] = [];
		try {
			liveSources.push((this.app as unknown as { bookmarks?: unknown }).bookmarks);
		} catch {
			/* ignore */
		}
		try {
			liveSources.push(
				(
					this.app as unknown as {
						internalPlugins?: { plugins?: Record<string, { instance?: unknown }> };
					}
				).internalPlugins?.plugins?.bookmarks?.instance
			);
		} catch {
			/* ignore */
		}

		for (const source of liveSources) {
			if (!source) continue;
			try {
				const s = source as {
					getBookmarks?: () => BookmarkItem[];
					items?: BookmarkItem[];
					groups?: BookmarkGroup[];
				};
				// Prefer the canonical `items` tree over the flattened
				// getBookmarks() list (which may duplicate group children).
				const items = Array.isArray(s.items) ? s.items : [];
				const groups = Array.isArray(s.groups) ? s.groups : [];
				if (items.length > 0 || groups.length > 0) return { items, groups };
				if (typeof s.getBookmarks === "function") {
					const flat = s.getBookmarks();
					if (Array.isArray(flat) && flat.length > 0) return { items: flat, groups: [] };
				}
				// Instance exists but is empty (data may not be loaded yet) —
				// fall through to the next source.
			} catch {
				/* ignore */
			}
		}

		// Final fallback: the core plugin's data file.
		try {
			const adapter = (this.app.vault as unknown as { adapter?: { read?: (p: string) => Promise<string> } }).adapter;
			if (adapter && typeof adapter.read === "function") {
				const raw = await adapter.read(".obsidian/bookmarks.json");
				if (raw) {
					const data = JSON.parse(raw) as { items?: BookmarkItem[]; groups?: BookmarkGroup[] };
					return {
						items: Array.isArray(data?.items) ? data.items : [],
						groups: Array.isArray(data?.groups) ? data.groups : [],
					};
				}
			}
		} catch {
			/* file missing or unparseable */
		}

		return null;
	}

	/* ------------------------------------------------------------------ */
	/* Rendering                                                           */
	/* ------------------------------------------------------------------ */

	private async renderInto(list: HTMLElement): Promise<void> {
		list.empty();

		const data = await this.resolveBookmarks();
		console.debug(
			"Page Header Bookmarks: bookmark data resolved",
			data ? { items: data.items.length, groups: data.groups.length } : null
		);
		if (!data) {
			list.createDiv({
				cls: "phb-empty",
				text: "未读取到书签数据（请确认核心插件「书签」已启用）",
			});
			const enableBtn = list.createEl("button", { cls: "phb-enable", text: "启用书签插件" });
			enableBtn.addEventListener("click", () => {
				void (
					this.app as unknown as {
						internalPlugins?: { plugins?: Record<string, { enable?: () => Promise<void> }> };
					}
				).internalPlugins?.plugins?.bookmarks?.enable?.();
				window.setTimeout(() => {
					void this.renderInto(list).then(() => this.positionPopover());
				}, 200);
			});
			return;
		}

		const nodes = this.buildTree(data);
		if (nodes.length === 0) {
			list.createDiv({
				cls: "phb-empty",
				text: "暂无书签。在文件或文件夹的右键菜单中点击「添加书签」。",
			});
			return;
		}

		this.renderNodes(list, nodes);
	}

	private buildTree(data: BookmarksData): TreeNode[] {
		// Items whose target no longer exists are hidden (same as the core
		// bookmarks view), and file/folder bookmarks inside a bookmarked
		// folder are only shown via that folder's expansion (dedup).
		const covered = this.computeCoveredPaths(data);

		const convert = (it: BookmarkItem | undefined): TreeNode | null => {
			if (!it) return null;
			if (it.type === "group") {
				// Nested groups are supported by the core bookmarks UI.
				const kids = (Array.isArray(it.items) ? it.items : [])
					.map(convert)
					.filter((n): n is TreeNode => n !== null);
				return { kind: "group", title: it.title || "未命名分组", children: kids };
			}
			if (
				(it.type === "file" || it.type === "folder") &&
				it.path &&
				covered.has(normalizePath(it.path))
			) {
				return null;
			}
			return this.itemToNode(it);
		};

		const root: TreeNode[] = [];
		for (const it of data.items) {
			const n = convert(it);
			if (n) root.push(n);
		}
		for (const g of data.groups) {
			const kids = (g?.items ?? [])
				.map(convert)
				.filter((n): n is TreeNode => n !== null);
			root.push({ kind: "group", id: g?.id, title: g?.title || "未命名分组", children: kids });
		}

		// Real data can duplicate a target both inside a group and as a
		// standalone item; the standalone copy is only visible after removing
		// the one that is already reachable by expanding the group.
		this.dropRootDuplicatesOfGroupItems(root);
		console.debug("Page Header Bookmarks: tree built", {
			items: data.items.length,
			groups: data.groups.length,
			coveredByFolders: covered.size,
			nodes: root.length,
		});
		return root;
	}

	/**
	 * Paths that should not appear as standalone bookmarks: every file and
	 * folder inside any bookmarked folder (they are reachable by expanding
	 * the folder bookmark instead).
	 */
	private computeCoveredPaths(data: BookmarksData): Set<string> {
		const folderPaths = new Set<string>();
		const collect = (it: BookmarkItem | undefined): void => {
			if (!it) return;
			if (it.type === "folder" && it.path) folderPaths.add(normalizePath(it.path));
			(it.items ?? []).forEach(collect);
		};
		data.items.forEach(collect);
		for (const g of data.groups) (g?.items ?? []).forEach(collect);

		const covered = new Set<string>();
		const visit = (path: string): void => {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (!(folder instanceof TFolder)) return;
			for (const child of folder.children) {
				if (child instanceof TFile) {
					covered.add(child.path);
				} else if (child instanceof TFolder) {
					covered.add(child.path);
					visit(child.path);
				}
			}
		};
		for (const p of folderPaths) visit(p);
		return covered;
	}

	private itemToNode(it: BookmarkItem | undefined): TreeNode | null {
		if (!it) return null;
		const type = it.type;
		if (type === "file") {
			const path = normalizePath(it.path ?? "");
			const file = this.app.vault.getAbstractFileByPath(path);
			// Deleted files are hidden, same as the core bookmarks view.
			if (!(file instanceof TFile)) return null;
			const title = it.title && it.title.trim() ? it.title : file.basename;
			return { kind: "file", title, path, subpath: it.subpath };
		}
		if (type === "folder") {
			const path = normalizePath(it.path ?? "");
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (!(folder instanceof TFolder)) return null;
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

	/** Stable identity for a tree node, used to keep expansion state across re-renders. */
	private nodeKey(node: TreeNode): string {
		switch (node.kind) {
			case "file":
				return `file:${node.path ?? ""}`;
			case "folder":
				return `folder:${node.path ?? ""}`;
			case "search":
				return `search:${node.query ?? node.path ?? node.title ?? ""}`;
			case "url":
				return `url:${node.url ?? node.title ?? ""}`;
			case "graph":
				return `graph:${node.title ?? ""}`;
			case "group":
				return `group:${node.id ?? node.title}`;
			default:
				return "";
		}
	}

	/** Exact bookmark target key (type + target fields) for duplicate detection. */
	private targetKey(n: TreeNode): string {
		switch (n.kind) {
			case "file":
				return `file:${n.path ?? ""}#${n.subpath ?? ""}`;
			case "folder":
				return `folder:${n.path ?? ""}`;
			case "search":
				return `search:${n.query ?? n.path ?? ""}`;
			case "url":
				return `url:${n.url ?? ""}`;
			case "graph":
				return `graph:${n.title ?? ""}`;
			default:
				return "";
		}
	}

	/**
	 * Real bookmark data can contain the same target both inside a group and
	 * as a standalone top-level item (e.g. a folder that is represented by a
	 * group bookmark). The standalone copy is a duplicate of something already
	 * visible when the group is expanded, so drop it. Matching is by exact
	 * target key only — never by basename or path prefix — to avoid hiding
	 * legitimately separate bookmarks (e.g. same-named files elsewhere).
	 */
	private dropRootDuplicatesOfGroupItems(root: TreeNode[]): void {
		const inGroups = new Set<string>();
		const collectChildren = (nodes: TreeNode[]): void => {
			for (const n of nodes) {
				if (n.kind === "group") collectChildren(n.children ?? []);
				else inGroups.add(this.targetKey(n));
			}
		};
		const collectGroups = (nodes: TreeNode[]): void => {
			for (const n of nodes) {
				if (n.kind === "group") {
					collectChildren(n.children ?? []);
					collectGroups(n.children ?? []);
				}
			}
		};
		collectGroups(root);
		for (let i = root.length - 1; i >= 0; i--) {
			const n = root[i];
			if (n.kind !== "group" && inGroups.has(this.targetKey(n))) root.splice(i, 1);
		}
	}

	private renderNodes(container: HTMLElement, nodes: TreeNode[]): void {
		for (const node of nodes) container.appendChild(this.renderNode(node));
	}

	private renderNode(node: TreeNode): HTMLElement {
		const wrap = createDiv({ cls: "phb-node" });
		const row = wrap.createDiv({ cls: ["phb-item", `phb-item-${node.kind}`] });

		if (node.kind === "group" || node.kind === "folder") {
			const hasChildren = node.kind === "folder" || (node.children?.length ?? 0) > 0;
			const isOpen = this.expanded.has(this.nodeKey(node));
			const caret = row.createSpan({ cls: ["phb-caret", ...(isOpen ? ["phb-open"] : [])] });
			caret.innerHTML = ICON_CHEVRON;
			if (!hasChildren) caret.addClass("phb-caret-empty");
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_FOLDER;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				if (hasChildren) this.toggleNode(node);
			});
			if (isOpen) {
				const children = createDiv({ cls: "phb-children" });
				wrap.appendChild(children);
				this.renderNodes(children, this.childrenOf(node));
			}
		} else if (node.kind === "file") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_FILE;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				this.openFile(node);
			});
		} else if (node.kind === "search") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_SEARCH;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				void this.openSearch(node);
			});
		} else if (node.kind === "url") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_LINK;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				this.openUrl(node);
			});
		} else {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_GRAPH;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				void this.openGraph(node);
			});
		}

		return wrap;
	}

	/** Children of a group (its bookmarks) or a folder (vault contents, lazily). */
	private childrenOf(node: TreeNode): TreeNode[] {
		if (node.kind === "group") return node.children ?? [];
		if (node.kind === "folder") {
			if (!node.children) {
				const folder = node.path ? this.app.vault.getAbstractFileByPath(node.path) : null;
				const kids: TreeNode[] = [];
				if (folder instanceof TFolder) {
					for (const child of folder.children) {
						if (child instanceof TFile) {
							kids.push({ kind: "file", title: child.basename, path: child.path });
						} else if (child instanceof TFolder) {
							kids.push({ kind: "folder", title: child.name, path: child.path });
						}
					}
					kids.sort((a, b) => {
						if (a.kind === "folder" && b.kind !== "folder") return -1;
						if (a.kind !== "folder" && b.kind === "folder") return 1;
						return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
					});
				}
				node.children = kids;
			}
			return node.children;
		}
		return [];
	}

	private toggleNode(node: TreeNode): void {
		// Empty groups have nothing to expand.
		if (node.kind === "group" && (node.children?.length ?? 0) === 0) return;
		const key = this.nodeKey(node);
		if (this.expanded.has(key)) this.expanded.delete(key);
		else this.expanded.add(key);
		this.rerenderList();
	}

	private rerenderList(): void {
		if (!this.listEl) return;
		const scrollTop = this.listEl.scrollTop;
		void this.renderInto(this.listEl).then(() => {
			if (this.listEl) this.listEl.scrollTop = scrollTop;
			this.positionPopover();
		});
	}

	/* ------------------------------------------------------------------ */
	/* Actions                                                             */
	/* ------------------------------------------------------------------ */

	private openFile(node: TreeNode): void {
		const file = node.path ? this.app.vault.getAbstractFileByPath(node.path) : null;
		if (!(file instanceof TFile)) {
			// Deleted between render and click — still close per the close rule.
			this.closePopover();
			return;
		}
		const linktext = (node.path ?? "") + (node.subpath ? "#" + node.subpath : "");
		void this.app.workspace.openLinkText(linktext, "", true);
		this.closePopover();
	}

	private async openSearch(node: TreeNode): Promise<void> {
		try {
			const query = node.query ?? node.path ?? node.title ?? "";
			const existing = this.app.workspace.getLeavesOfType("search");
			const leaf: WorkspaceLeaf | null = existing[0] ?? this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: "search", state: { query } });
				this.app.workspace.revealLeaf(leaf);
			}
		} catch (e) {
			console.error("Page Header Bookmarks: failed to open search", e);
		} finally {
			this.closePopover();
		}
	}

	private openUrl(node: TreeNode): void {
		const url = node.url ?? "";
		if (url) {
			try {
				window.open(url, "_blank");
			} catch (e) {
				console.error("Page Header Bookmarks: failed to open url", e);
			}
		}
		this.closePopover();
	}

	private async openGraph(node: TreeNode): Promise<void> {
		try {
			const existing = this.app.workspace.getLeavesOfType("graph");
			const leaf: WorkspaceLeaf | null = existing[0] ?? this.app.workspace.getRightLeaf(false);
			if (leaf) {
				const state: Record<string, unknown> = { query: "" };
				if (node.options && typeof node.options === "object") Object.assign(state, node.options);
				await leaf.setViewState({ type: "graph", state });
				this.app.workspace.revealLeaf(leaf);
			}
		} catch (e) {
			console.error("Page Header Bookmarks: failed to open graph", e);
		} finally {
			this.closePopover();
		}
	}
}
