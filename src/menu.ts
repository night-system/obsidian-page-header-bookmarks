/* ------------------------------------------------------------------ */
/* Context menu + modals for the bookmark popover.                     */
/*                                                                     */
/* buildMenuItemDefs is a pure function (unit-tested in                */
/* tests/menu.test.cjs); showNodeMenu and the modals are thin obsidian  */
/* UI bindings (not unit-tested — they need the obsidian runtime).      */
/* ------------------------------------------------------------------ */

import { FuzzySuggestModal, Menu, Modal, Setting } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import type { BookmarkItemLike, TreeNode } from "./tree";

export type MenuItemId =
	| "open"
	| "openNewTab"
	| "copy"
	| "toggle"
	| "rename"
	| "moveToGroup"
	| "delete";

export interface MenuItemDef {
	id: MenuItemId;
	title: string;
	icon: string;
	/** Insert a separator before this item. */
	separatorBefore?: boolean;
	dangerous?: boolean;
	/** Confirmation body shown before running the action (group delete). */
	confirm?: string;
}

export interface MenuOptions {
	/** Hide write operations (rename / move / delete) — read-only mode. */
	readonly?: boolean;
	/** Descendant bookmark count of a group (delete confirmation text). */
	groupItemCount?: number;
	/** Current expansion state of a group / folder row. */
	expanded?: boolean;
	/** Whether the row has children to expand (false hides the toggle item). */
	canToggle?: boolean;
}

export interface NodeMenuHandlers {
	open?: () => void;
	openNewTab?: () => void;
	copy?: () => void;
	toggle?: () => void;
	rename?: () => void;
	moveToGroup?: () => void;
	delete?: () => void;
}

export type GroupChoice = { group: BookmarkItemLike | null; label: string };

const LABELS = {
	open: "打开",
	openNewTab: "新标签页打开",
	copyFile: "复制链接",
	copySearch: "复制查询",
	rename: "重命名",
	moveToGroup: "移动到分组…",
	delete: "删除",
	toggleExpand: "展开",
	toggleCollapse: "收起",
} as const;

/**
 * Menu items for a node, in display order. Pure — unit-tested.
 * Write operations are filtered out in read-only mode.
 */
export function buildMenuItemDefs(node: TreeNode, opts: MenuOptions = {}): MenuItemDef[] {
	const defs: MenuItemDef[] = [];
	const writable = !opts.readonly;

	if (node.kind === "group" || node.kind === "folder") {
		if (opts.canToggle !== false) {
			const toggleTitle = opts.expanded ? LABELS.toggleCollapse : LABELS.toggleExpand;
			defs.push({ id: "toggle", title: toggleTitle, icon: "chevron-right" });
		}
	} else {
		defs.push({ id: "open", title: LABELS.open, icon: "file" });
		defs.push({ id: "openNewTab", title: LABELS.openNewTab, icon: "file-plus" });
		// Graph bookmarks have no link/query to copy — open-only.
		if (node.kind === "file" || node.kind === "search" || node.kind === "url") {
			const copyTitle = node.kind === "search" ? LABELS.copySearch : LABELS.copyFile;
			defs.push({ id: "copy", title: copyTitle, icon: "link" });
		}
	}
	if (!writable) return defs;

	defs.push({ id: "rename", title: LABELS.rename, icon: "pencil", separatorBefore: true });
	defs.push({ id: "moveToGroup", title: LABELS.moveToGroup, icon: "folder-input" });
	const isGroup = node.kind === "group";
	const deleteDef: MenuItemDef = { id: "delete", title: LABELS.delete, icon: "trash", separatorBefore: true };
	if (isGroup) {
		deleteDef.dangerous = true;
		deleteDef.confirm = `删除分组「${node.title}」将同时删除组内 ${opts.groupItemCount ?? 0} 个书签，此操作不可撤销。`;
	}
	defs.push(deleteDef);
	return defs;
}

/** Open the context menu at a position (works for right-click and touch long-press). */
export function showNodeMenu(
	app: App,
	node: TreeNode,
	pos: { x: number; y: number },
	opts: MenuOptions,
	handlers: NodeMenuHandlers,
	onHide?: () => void
): void {
	const defs = buildMenuItemDefs(node, opts);
	const menu = new Menu();
	for (const def of defs) {
		if (def.separatorBefore) menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(def.title).setIcon(def.icon);
			item.onClick(() => handlers[def.id]?.());
		});
	}
	if (onHide) menu.onHide(onHide);
	menu.showAtPosition(pos);
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

export class RenameModal extends Modal {
	private value: string;

	constructor(app: App, initial: string, private onSubmit: (value: string) => void) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("重命名书签");
		new Setting(contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.focus();
			t.inputEl.select();
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("确定").setCta().onClick(() => this.submit()))
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
	}

	private submit(): void {
		const v = this.value.trim();
		this.close();
		if (v) this.onSubmit(v);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Fuzzy group picker; choices are precomputed (root option included by caller). */
export class GroupPickerModal extends FuzzySuggestModal<GroupChoice> {
	constructor(
		app: App,
		private choices: GroupChoice[],
		private onPick: (group: BookmarkItemLike | null) => void
	) {
		super(app);
		this.setPlaceholder("选择目标分组");
	}

	getItems(): GroupChoice[] {
		return this.choices;
	}

	getItemText(item: GroupChoice): string {
		return item.label;
	}

	renderSuggestion(match: FuzzyMatch<GroupChoice>, el: HTMLElement): void {
		const segs = match.item.label.split(" / ");
		el.setText(segs[segs.length - 1] ?? match.item.label);
		el.style.paddingLeft = `${8 + (segs.length - 1) * 16}px`;
	}

	onChooseItem(item: GroupChoice): void {
		this.onPick(item.group);
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private body: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "确认删除" });
		contentEl.createEl("p", { text: this.body });
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("删除").setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				})
			)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
