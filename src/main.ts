import { Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";

/* ------------------------------------------------------------------ */
/* Internal core-plugin "Bookmarks" API (not part of the public API)   */
/* ------------------------------------------------------------------ */

interface BookmarkItem {
	type?: "file" | "folder" | "group" | "search";
	title?: string;
	path?: string;
	subpath?: string;
	/** Search bookmarks store their query in this field (core plugin schema). */
	query?: string;
	items?: BookmarkItem[];
}

interface BookmarkGroup {
	id?: string;
	title?: string;
	items?: BookmarkItem[];
}

interface BookmarksAPI {
	items?: BookmarkItem[];
	groups?: BookmarkGroup[];
}

/* ------------------------------------------------------------------ */
/* Icons (Lucide-style inline SVGs)                                    */
/* ------------------------------------------------------------------ */

const ICON_BOOKMARK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
const ICON_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;
const ICON_SEARCH = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
const ICON_CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/* ------------------------------------------------------------------ */
/* Tree model                                                          */
/* ------------------------------------------------------------------ */

type NodeKind = "group" | "folder" | "file" | "search";

interface TreeNode {
	kind: NodeKind;
	title: string;
	path?: string;
	subpath?: string;
	/** Search bookmarks: the search query. */
	query?: string;
	/** Groups: stable id when the core plugin provides one. */
	id?: string;
	/** The underlying file no longer exists. */
	missing?: boolean;
	/** Lazily loaded / prebuilt children (groups and folders). */
	children?: TreeNode[];
}

export default class PageHeaderBookmarksPlugin extends Plugin {
	private observer: MutationObserver | null = null;
	private syncQueued = false;

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
		this.app.workspace.onLayoutReady(() => this.syncHeaders());

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.syncHeaders();
				// The pane holding the popover's anchor button is gone.
				if (this.popover && this.anchor && !this.anchor.isConnected) this.closePopover();
			})
		);

		this.observer = new MutationObserver(() => this.queueSync());
		this.observer.observe(this.app.workspace.containerEl, { childList: true, subtree: true });

		this.register(() => {
			this.observer?.disconnect();
			this.closePopover();
			// Remove injected page-header buttons so a disabled plugin leaves no residue.
			this.app.workspace.containerEl
				.querySelectorAll<HTMLElement>(".phb-button")
				.forEach((btn) => btn.remove());
		});
	}

	/* ------------------------------------------------------------------ */
	/* Page header button ("page header" as defined by the Commander      */
	/* plugin: the title bar at the top of each pane, i.e. .view-header)  */
	/* ------------------------------------------------------------------ */

	private queueSync(): void {
		if (this.syncQueued) return;
		this.syncQueued = true;
		requestAnimationFrame(() => {
			this.syncQueued = false;
			this.syncHeaders();
		});
	}

	private syncHeaders(): void {
		const root = this.app.workspace.containerEl;
		root.querySelectorAll<HTMLElement>(".view-header").forEach((header) => {
			if (header.querySelector(".phb-button")) return;
			const btn = header.createEl("button", {
				cls: "phb-button clickable-icon view-action",
				attr: { "aria-label": "书签" },
			});
			btn.innerHTML = ICON_BOOKMARK;
			const right = header.querySelector<HTMLElement>(".view-header-right");
			const actions = header.querySelector<HTMLElement>(".view-actions");
			if (right && actions) right.insertBefore(btn, actions);
			else if (right) right.appendChild(btn);
			else header.appendChild(btn);
			btn.addEventListener("click", (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this.togglePopover(btn);
			});
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
		this.renderInto(this.listEl);

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
	/* Rendering                                                           */
	/* ------------------------------------------------------------------ */

	private renderInto(list: HTMLElement): void {
		list.empty();

		const bookmarksInternal = (
			this.app as unknown as {
				internalPlugins?: { plugins?: Record<string, { enabled?: boolean; enable?: () => Promise<void> }> };
			}
		).internalPlugins?.plugins?.bookmarks;
		if (!bookmarksInternal?.enabled) {
			list.createDiv({ cls: "phb-empty", text: "核心插件「书签」未启用" });
			const enableBtn = list.createEl("button", { cls: "phb-enable", text: "启用书签插件" });
			enableBtn.addEventListener("click", () => {
				void bookmarksInternal?.enable?.();
				window.setTimeout(() => {
					this.renderInto(list);
					this.positionPopover();
				}, 150);
			});
			return;
		}

		const nodes = this.buildTree();
		if (nodes.length === 0) {
			list.createDiv({
				cls: "phb-empty",
				text: "暂无书签。在文件或文件夹的右键菜单中点击「添加书签」。",
			});
			return;
		}

		this.renderNodes(list, nodes);
	}

	private buildTree(): TreeNode[] {
		const bm = (this.app as unknown as { bookmarks?: BookmarksAPI }).bookmarks;
		const root: TreeNode[] = [];
		if (!bm) return root;

		const items: BookmarkItem[] = Array.isArray(bm.items) ? bm.items : [];
		const groups: BookmarkGroup[] = Array.isArray(bm.groups) ? bm.groups : [];

		for (const it of items) {
			if (it?.type === "group" && Array.isArray(it.items) && it.items.length > 0) {
				const kids = it.items
					.map((x) => this.itemToNode(x))
					.filter((n): n is TreeNode => n !== null);
				if (kids.length > 0) root.push({ kind: "group", title: it.title || "未命名分组", children: kids });
			} else {
				const n = this.itemToNode(it);
				if (n) root.push(n);
			}
		}
		for (const g of groups) {
			const kids = (g?.items ?? [])
				.map((x) => this.itemToNode(x))
				.filter((n): n is TreeNode => n !== null);
			if (kids.length > 0) root.push({ kind: "group", id: g?.id, title: g?.title || "未命名分组", children: kids });
		}
		return root;
	}

	private itemToNode(it: BookmarkItem | undefined): TreeNode | null {
		if (!it) return null;
		const type = it.type;
		if (type === "file") {
			const path = it.path ?? "";
			const file = this.app.vault.getAbstractFileByPath(path);
			const missing = !(file instanceof TFile);
			return { kind: "file", title: it.title || path.replace(/\.md$/, ""), path, subpath: it.subpath, missing };
		}
		if (type === "folder") {
			return { kind: "folder", title: it.title || (it.path ?? "").split("/").pop() || "", path: it.path ?? "" };
		}
		if (type === "search") {
			const query = it.query ?? it.path ?? "";
			return { kind: "search", title: it.title || query || "搜索", query, path: it.path ?? "" };
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
			case "group":
				return `group:${node.id ?? node.title}`;
			default:
				return "";
		}
	}

	private renderNodes(container: HTMLElement, nodes: TreeNode[]): void {
		for (const node of nodes) container.appendChild(this.renderNode(node));
	}

	private renderNode(node: TreeNode): HTMLElement {
		const wrap = createDiv({ cls: "phb-node" });
		const row = wrap.createDiv({ cls: ["phb-item", `phb-item-${node.kind}`] });

		if (node.kind === "group" || node.kind === "folder") {
			const isOpen = this.expanded.has(this.nodeKey(node));
			const caret = row.createSpan({ cls: ["phb-caret", ...(isOpen ? ["phb-open"] : [])] });
			caret.innerHTML = ICON_CHEVRON;
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_FOLDER;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				this.toggleNode(node);
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
			if (node.missing) row.addClass("phb-item-missing");
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				this.openFile(node);
			});
		} else {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_SEARCH;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				void this.openSearch(node);
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
		const key = this.nodeKey(node);
		if (this.expanded.has(key)) this.expanded.delete(key);
		else this.expanded.add(key);
		this.rerenderList();
	}

	private rerenderList(): void {
		if (!this.listEl) return;
		const scrollTop = this.listEl.scrollTop;
		this.renderInto(this.listEl);
		this.listEl.scrollTop = scrollTop;
		this.positionPopover();
	}

	/* ------------------------------------------------------------------ */
	/* Actions                                                             */
	/* ------------------------------------------------------------------ */

	private openFile(node: TreeNode): void {
		if (node.missing) return;
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
}
