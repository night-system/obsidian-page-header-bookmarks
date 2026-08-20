import { ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { buildTree, isFileLike, isFolderLike } from "./tree";
import type {
	BookmarkGroupLike as BookmarkGroup,
	BookmarkItemLike as BookmarkItem,
	BookmarksDataLike as BookmarksData,
	TreeNode,
	VaultLike,
} from "./tree";
import { attachRowDrag, ClickSuppressor, CLICK_SUPPRESS_RESET_MS, computeDropAction } from "./dnd";
import type { DragGestureState, DropTarget } from "./dnd";
import { ConfirmModal, GroupPickerModal, RenameModal, showNodeMenu } from "./menu";
import type { GroupChoice, MenuOptions, NodeMenuHandlers } from "./menu";
import {
	applyMoveToGroupChoice,
	BOOKMARKS_FILE,
	commitWrite,
	countGroupItems,
	groupChoicesFor,
	keyOrdinalOf,
	locateItem,
	locateItemAtOrdinal,
	mapNodesToRaw,
	moveItemInData,
	parseBookmarksFile,
	removeItemFromData,
	renameItemInData,
} from "./writeback";
import type { BookmarksInstanceLike, FileAdapterLike, WriteSource } from "./writeback";

/* ------------------------------------------------------------------ */
/* Bookmark data model + tree building / dedup live in src/tree.ts      */
/* (pure logic, no obsidian import); this file only wires the vault in  */
/* and renders the resulting tree.                                      */
/* ------------------------------------------------------------------ */

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

type WriteMode = "instance" | "file" | "none";

interface ResolvedBookmarks {
	data: BookmarksData;
	mode: WriteMode;
	instance: BookmarksInstanceLike | null;
	adapter: FileAdapterLike | null;
}

export default class PageHeaderBookmarksPlugin extends Plugin {
	/** Injected page-header buttons, keyed by the view they belong to. */
	private buttons = new WeakMap<ItemView, HTMLElement>();

	private backdrop: HTMLElement | null = null;
	private popover: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private expanded = new Set<string>();

	/** Rendered row → raw bookmark item / tree node (for menu & drag). */
	private rowItems = new WeakMap<HTMLElement, BookmarkItem>();
	private rowNodes = new WeakMap<HTMLElement, TreeNode>();

	/**
	 * Suppresses the click synthesized after a touch long-press / drag.
	 * Auto-resets after CLICK_SUPPRESS_RESET_MS when never consumed — a
	 * drag re-render may remove the row that would have consumed it, and a
	 * stale flag must not swallow an unrelated later row click.
	 */
	private clickSuppressor = new ClickSuppressor(
		CLICK_SUPPRESS_RESET_MS,
		(fn, ms) => window.setTimeout(fn, ms),
		(id) => window.clearTimeout(id)
	);
	/** Render-time same-key ordinal of each tree node (duplicate-safe re-location). */
	private renderOrdinals = new WeakMap<TreeNode, number>();
	/** Shared long-press timestamp (touch-synthesized contextmenu filter). */
	private gestureState: DragGestureState = { lastTouchAt: 0 };
	/** How the current data can be written back ("none" = read-only). */
	private writeMode: WriteMode = "none";

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
	 * Fetch bookmark data from every source we know about, newest first
	 * (same priority as v1.0.7, plus write-back metadata):
	 *   1. live instances (`app.bookmarks`, `app.internalPlugins…instance`)
	 *      — the `items` tree is authoritative (it preserves group nesting),
	 *      so prefer it over the `getBookmarks()` flat list, which may
	 *      float group-nested items up to the top level;
	 *   2. the core plugin's data file `.obsidian/bookmarks.json` (most
	 *      reliable across versions; read on demand so it is always fresh).
	 *
	 * `mode` describes how the data can be written back:
	 *   - "instance"  → mutate `instance.items` + onItemsChanged(true);
	 *   - "file"      → write `.obsidian/bookmarks.json` (backup + verify);
	 *   - "none"      → read-only (e.g. data came from a flat getBookmarks()
	 *                   list, which cannot be written back safely).
	 */
	private async resolveBookmarks(): Promise<ResolvedBookmarks | null> {
		const instances: BookmarksInstanceLike[] = [];
		try {
			const b = (this.app as unknown as { bookmarks?: unknown }).bookmarks as
				| BookmarksInstanceLike
				| undefined;
			if (b) instances.push(b);
		} catch {
			/* ignore */
		}
		try {
			const inst = (
				this.app as unknown as {
					internalPlugins?: { plugins?: Record<string, { instance?: unknown }> };
				}
			).internalPlugins?.plugins?.bookmarks?.instance as BookmarksInstanceLike | undefined;
			if (inst && !instances.includes(inst)) instances.push(inst);
		} catch {
			/* ignore */
		}

		let adapter: FileAdapterLike | null = null;
		try {
			adapter = (this.app.vault as unknown as { adapter?: FileAdapterLike }).adapter ?? null;
		} catch {
			/* ignore */
		}

		for (const inst of instances) {
			try {
				const items = Array.isArray(inst.items) ? inst.items : [];
				const rawGroups = (inst as unknown as { groups?: BookmarkGroup[] }).groups;
				const groups = Array.isArray(rawGroups) ? rawGroups : [];
				if (items.length > 0 || groups.length > 0) {
					return {
						data: { items, groups },
						mode: "instance",
						instance: inst,
						adapter,
					};
				}
				if (typeof (inst as { getBookmarks?: () => BookmarkItem[] }).getBookmarks === "function") {
					const flat = (inst as { getBookmarks?: () => BookmarkItem[] }).getBookmarks?.();
					if (Array.isArray(flat) && flat.length > 0) {
						// Flat lists cannot be written back safely → read-only.
						return { data: { items: flat, groups: [] }, mode: "none", instance: inst, adapter };
					}
				}
				// Instance exists but is empty (data may not be loaded yet) —
				// fall through to the next source.
			} catch {
				/* ignore */
			}
		}

		// Final fallback: the core plugin's data file.
		if (adapter && typeof adapter.read === "function") {
			try {
				const raw = await adapter.read(BOOKMARKS_FILE);
				const parsed = parseBookmarksFile(raw);
				if (parsed) {
					// A legal empty file ({"items":[]}) is valid data too —
					// the UI then renders the "暂无书签" guide instead of
					// the "未读取到书签数据" error.
					const mode: WriteMode = typeof adapter.write === "function" ? "file" : "none";
					return { data: parsed, mode, instance: instances[0] ?? null, adapter };
				}
			} catch {
				/* file missing or unparseable */
			}
		}

		return null;
	}

	/* ------------------------------------------------------------------ */
	/* Rendering                                                           */
	/* ------------------------------------------------------------------ */

	private async renderInto(list: HTMLElement): Promise<void> {
		list.empty();

		const resolved = await this.resolveBookmarks();
		const data = resolved?.data ?? null;
		this.writeMode = resolved?.mode ?? "none";
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

		const nodes = buildTree(data, this.app.vault as unknown as VaultLike);
		if (nodes.length === 0) {
			list.createDiv({
				cls: "phb-empty",
				text: "暂无书签。在文件或文件夹的右键菜单中点击「添加书签」。",
			});
			return;
		}

		const map = mapNodesToRaw(nodes, data, this.app.vault as unknown as VaultLike);
		this.renderOrdinals = this.computeRenderOrdinals(nodes, data, map);
		this.renderNodes(list, nodes, map);
	}

	/**
	 * Same-key ordinal of each rendered node in `data` (0-based, in data
	 * DFS order). After a file-mode re-read the render reference is a
	 * different object, so locateIn uses this ordinal to hit the exact
	 * duplicate bookmark instead of always the first same-key match.
	 */
	private computeRenderOrdinals(
		nodes: TreeNode[],
		data: BookmarksData,
		map: Map<TreeNode, BookmarkItem>
	): WeakMap<TreeNode, number> {
		const ordinals = new WeakMap<TreeNode, number>();
		const stack = [...nodes];
		while (stack.length > 0) {
			const node = stack.pop() as TreeNode;
			const raw = map.get(node);
			if (raw) {
				const ord = keyOrdinalOf(data, this.itemKeyOf(node), raw);
				if (ord >= 0) ordinals.set(node, ord);
			}
			if (node.children) stack.push(...node.children);
		}
		return ordinals;
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

	private renderNodes(container: HTMLElement, nodes: TreeNode[], map: Map<TreeNode, BookmarkItem>): void {
		for (const node of nodes) container.appendChild(this.renderNode(node, map));
	}

	private renderNode(node: TreeNode, map: Map<TreeNode, BookmarkItem>): HTMLElement {
		const wrap = createDiv({ cls: "phb-node" });
		const row = createDiv({ cls: ["phb-item", `phb-item-${node.kind}`] });
		const raw = map.get(node) ?? null;
		if (raw) {
			this.rowItems.set(row, raw);
			this.rowNodes.set(row, node);
		}

		// Existing click behavior, unchanged, with a guard that consumes the
		// synthetic click after a touch long-press / drag.
		const guard = (fn: () => void) => (e: MouseEvent): void => {
			e.stopPropagation();
			if (this.consumeSuppressedClick()) return;
			fn();
		};

		if (node.kind === "group" || node.kind === "folder") {
			const hasChildren = node.kind === "folder" || (node.children?.length ?? 0) > 0;
			const isOpen = this.expanded.has(this.nodeKey(node));
			const caret = row.createSpan({ cls: ["phb-caret", ...(isOpen ? ["phb-open"] : [])] });
			caret.innerHTML = ICON_CHEVRON;
			if (!hasChildren) caret.addClass("phb-caret-empty");
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_FOLDER;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", guard(() => {
				if (hasChildren) this.toggleNode(node);
			}));
			if (isOpen) {
				const children = createDiv({ cls: "phb-children" });
				wrap.appendChild(children);
				this.renderNodes(children, this.childrenOf(node), map);
			}
		} else if (node.kind === "file") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_FILE;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", guard(() => this.openFile(node)));
		} else if (node.kind === "search") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_SEARCH;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", guard(() => void this.openSearch(node)));
		} else if (node.kind === "url") {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_LINK;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", guard(() => this.openUrl(node)));
		} else {
			const icon = row.createSpan({ cls: "phb-item-icon" });
			icon.innerHTML = ICON_GRAPH;
			row.createDiv({ cls: "phb-item-title", text: node.title });
			row.addEventListener("click", guard(() => void this.openGraph(node)));
		}

		if (raw) {
			// Right-click menu (immediate). Touch long-press menus are raised
			// by the drag gesture; the synthesized contextmenu is ignored.
			row.addEventListener("contextmenu", (e: MouseEvent) => {
				e.preventDefault();
				if (Date.now() - this.gestureState.lastTouchAt < 1000) return;
				this.showNodeMenu(node, raw, { x: e.clientX, y: e.clientY }, false);
			});
			if (this.writeMode !== "none") {
				attachRowDrag(
					row,
					{
						listEl: this.listEl as HTMLElement,
						isBookmarkRow: (r) => this.rowItems.has(r),
						isGroupRow: (r) => r.classList.contains("phb-item-group"),
						onMenu: (pos) => this.showNodeMenu(node, raw, pos, true),
						onDrop: (target) => void this.handleDrop(node, raw, target),
					},
					this.gestureState
				);
			}
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
				if (isFolderLike(folder)) {
					for (const child of folder.children) {
						if (isFileLike(child)) {
							kids.push({ kind: "file", title: child.basename, path: child.path });
						} else if (isFolderLike(child)) {
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
	/* Click suppression (touch long-press / drag → synthetic click)       */
	/* (ClickSuppressor auto-resets if the flag is never consumed, so a    */
	/* stale flag after a drag re-render cannot swallow a later click.)    */
	/* ------------------------------------------------------------------ */

	private consumeSuppressedClick(): boolean {
		return this.clickSuppressor.consume();
	}

	/* ------------------------------------------------------------------ */
	/* Menu                                                               */
	/* ------------------------------------------------------------------ */

	private showNodeMenu(node: TreeNode, raw: BookmarkItem, pos: { x: number; y: number }, fromTouch: boolean): void {
		// A touch long-press synthesizes a click when the finger lifts —
		// consume it; a right-click never produces a click.
		if (fromTouch) this.clickSuppressor.setActive(true);

		const opts: MenuOptions = { readonly: this.writeMode === "none" };
		if (node.kind === "group") {
			opts.groupItemCount = countGroupItems(raw);
			opts.expanded = this.expanded.has(this.nodeKey(node));
			opts.canToggle = (node.children?.length ?? 0) > 0;
		} else if (node.kind === "folder") {
			opts.expanded = this.expanded.has(this.nodeKey(node));
		}

		const handlers: NodeMenuHandlers = {
			open: () => this.openBookmarkAction(node, false),
			openNewTab: () => this.openBookmarkAction(node, true),
			copy: () => this.copyBookmarkAction(node),
			toggle: () => this.toggleNode(node),
			rename: () => this.renameBookmark(node, raw),
			moveToGroup: () => void this.moveBookmarkToGroup(node, raw),
			delete: () => this.deleteBookmark(node, raw),
		};
		showNodeMenu(this.app, node, pos, opts, handlers, () => {
			this.clickSuppressor.setActive(false);
		});
	}

	private openBookmarkAction(node: TreeNode, newLeaf: boolean): void {
		if (node.kind === "file") this.openFile(node, newLeaf);
		else if (node.kind === "search") void this.openSearch(node, newLeaf);
		else if (node.kind === "url") this.openUrl(node);
		else if (node.kind === "graph") void this.openGraph(node, newLeaf);
	}

	private copyBookmarkAction(node: TreeNode): void {
		let text = "";
		if (node.kind === "file") {
			const vaultName = this.app.vault.getName();
			const base = node.path ?? "";
			const sub = node.subpath ? "#" + node.subpath : "";
			text = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(base)}${sub}`;
		} else if (node.kind === "search") {
			text = node.query ?? node.path ?? node.title ?? "";
		} else if (node.kind === "url") {
			text = node.url ?? "";
		}
		if (text) void navigator.clipboard.writeText(text);
	}

	private renameBookmark(node: TreeNode, raw: BookmarkItem): void {
		new RenameModal(this.app, node.title, (value) => {
			void this.applyWrite(node, raw, (_data, item) => {
				renameItemInData(item, value);
				return true;
			});
		}).open();
	}

	private deleteBookmark(node: TreeNode, raw: BookmarkItem): void {
		const doDelete = (): void => {
			void this.applyWrite(node, raw, (data, item) => removeItemFromData(data, item));
		};
		if (node.kind === "group") {
			const count = countGroupItems(raw);
			new ConfirmModal(
				this.app,
				`删除分组「${node.title}」将同时删除组内 ${count} 个书签，此操作不可撤销。`,
				doDelete
			).open();
		} else {
			doDelete();
		}
	}

	private async moveBookmarkToGroup(node: TreeNode, raw: BookmarkItem): Promise<void> {
		const resolved = await this.resolveBookmarks();
		if (!resolved?.data) return;
		const data = resolved.data;
		const item = this.locateIn(data, raw, node);
		if (!item) {
			new Notice("书签不存在或已变化，请重试");
			return;
		}
		const choices: GroupChoice[] = [
			{ group: null, label: "（顶层）" },
			...groupChoicesFor(data, item).map((e) => ({ group: e.group, label: e.label })),
		];
		new GroupPickerModal(this.app, choices, (target) => {
			// target === null = "（顶层）" → move to the root list (append).
			// (FuzzySuggestModal only calls onChooseItem on a real selection,
			// so null can only mean the top-level option.)
			void this.applyWrite(node, raw, (d, it) =>
				applyMoveToGroupChoice(d, it, target, (g) => this.containerKeyOf(g))
			);
		}).open();
	}

	/* ------------------------------------------------------------------ */
	/* Drag & drop                                                         */
	/* ------------------------------------------------------------------ */

	private async handleDrop(node: TreeNode, raw: BookmarkItem, target: DropTarget): Promise<void> {
		// The drop synthesizes a click; suppress it. The suppressor
		// auto-resets if the re-render removed the row that would have
		// consumed it, so the next row click is not swallowed.
		this.clickSuppressor.setActive(true);
		if (target.kind === "none") return;
		const resolved = await this.resolveBookmarks();
		if (!resolved?.data) return;
		const data = resolved.data;

		const dragItem = this.locateIn(data, raw, node);
		if (!dragItem) return; // stale row (data changed) → no-op

		let targetItem: BookmarkItem | null = null;
		if (target.kind === "row") {
			const tNode = this.rowNodes.get(target.row) ?? null;
			const tRaw = this.rowItems.get(target.row) ?? null;
			targetItem = tRaw ? this.locateIn(data, tRaw, tNode) : null;
			if (!targetItem) return;
		}

		const mode = target.kind === "empty" ? "top" : target.mode;
		const action = computeDropAction(data, dragItem, targetItem, mode);
		if (!action.ok) return;

		await this.commitAction(resolved, data, (d) => moveItemInData(d, dragItem, action.target, action.index));
	}

	/* ------------------------------------------------------------------ */
	/* Write-back                                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * Locate a raw item in `data` by identity, then by a stable key.
	 * After a file re-read the render reference is a different object, so
	 * the key fallback hits the exact slot among duplicate same-key
	 * bookmarks via the render-time ordinal.
	 */
	private locateIn(data: BookmarksData, obj: BookmarkItem, node: TreeNode | null): BookmarkItem | null {
		const byId = locateItem(data, (it) => it === obj);
		if (byId) return byId.item;
		if (node) {
			const key = this.itemKeyOf(node);
			const byKey = locateItemAtOrdinal(data, key, this.renderOrdinals.get(node) ?? 0);
			if (byKey) return byKey.item;
			// Data changed since render → the ordinal may no longer hold;
			// fall back to any same-key match.
			const anyKey = locateItem(data, key);
			if (anyKey) return anyKey.item;
		}
		return null;
	}

	/** Stable key predicate for a rendered node (fallback when identity is lost). */
	private itemKeyOf(node: TreeNode): (it: BookmarkItem) => boolean {
		switch (node.kind) {
			case "file":
				return (it) =>
					it.type === "file" &&
					it.path === node.path &&
					(it.subpath ?? "") === (node.subpath ?? "");
			case "folder":
				return (it) => it.type === "folder" && it.path === node.path;
			case "search":
				return (it) => it.type === "search" && (it.query ?? "") === (node.query ?? "");
			case "url":
				return (it) => it.type === "url" && (it.url ?? "") === (node.url ?? "");
			case "graph":
				return (it) => it.type === "graph" && (it.title ?? "图谱") === (node.title ?? "图谱");
			case "group":
				if (node.id != null) return (it) => (it as { id?: string }).id === node.id;
				return (it) => it.type === "group" && (it.title ?? "") === (node.title ?? "");
			default:
				return () => false;
		}
	}

	private containerKeyOf(group: BookmarkItem): (it: BookmarkItem) => boolean {
		return (it) => {
			if (!Array.isArray((it as { items?: unknown }).items)) return false;
			if (group.id != null) return (it as { id?: string }).id === group.id;
			return (it.title ?? "") === (group.title ?? "");
		};
	}

	/**
	 * Re-resolve the data, locate the item, run the mutation and persist
	 * via commitWrite (instance → onItemsChanged; file → backup + write +
	 * verify). Refreshes the popover on success; notices on failure.
	 */
	private async applyWrite(
		node: TreeNode,
		raw: BookmarkItem,
		op: (data: BookmarksData, item: BookmarkItem) => boolean
	): Promise<void> {
		const resolved = await this.resolveBookmarks();
		if (!resolved?.data) {
			new Notice("无法读取书签数据");
			return;
		}
		const data = resolved.data;
		const item = this.locateIn(data, raw, node);
		if (!item) {
			new Notice("书签不存在或已变化，请重试");
			return;
		}
		await this.commitAction(resolved, data, (d) => op(d, item));
	}

	/** Apply a mutation against `data` and persist through commitWrite. */
	private async commitAction(resolved: ResolvedBookmarks, data: BookmarksData, mutate: (d: BookmarksData) => boolean): Promise<void> {
		if (resolved.mode === "none") {
			new Notice("当前为只读模式，无法修改书签");
			return;
		}
		const source: WriteSource = {
			mode: resolved.mode,
			data,
			instance: resolved.instance,
			adapter: resolved.adapter,
			filePath: BOOKMARKS_FILE,
		};
		const result = await commitWrite(source, mutate);
		if (result.ok) {
			this.rerenderList();
			return;
		}
		if (result.reason === "rejected") return; // silent no-op
		console.error("Page Header Bookmarks: write failed", result);
		new Notice("书签写回失败，已还原");
	}

	/* ------------------------------------------------------------------ */
	/* Actions                                                             */
	/* ------------------------------------------------------------------ */

	private openFile(node: TreeNode, newLeaf = true): void {
		const file = node.path ? this.app.vault.getAbstractFileByPath(node.path) : null;
		if (!isFileLike(file)) {
			// Deleted between render and click — still close per the close rule.
			this.closePopover();
			return;
		}
		const linktext = (node.path ?? "") + (node.subpath ? "#" + node.subpath : "");
		void this.app.workspace.openLinkText(linktext, "", newLeaf);
		this.closePopover();
	}

	private async openSearch(node: TreeNode, newLeaf = false): Promise<void> {
		try {
			const query = node.query ?? node.path ?? node.title ?? "";
			const existing = this.app.workspace.getLeavesOfType("search");
			const leaf: WorkspaceLeaf | null = existing[0] ?? this.app.workspace.getRightLeaf(newLeaf);
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

	private async openGraph(node: TreeNode, newLeaf = false): Promise<void> {
		try {
			const existing = this.app.workspace.getLeavesOfType("graph");
			const leaf: WorkspaceLeaf | null = existing[0] ?? this.app.workspace.getRightLeaf(newLeaf);
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
