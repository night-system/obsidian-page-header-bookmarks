/* ------------------------------------------------------------------ */
/* Drag & drop: Pointer Events gesture state machine (plain DOM only,  */
/* no obsidian imports) + pure drop geometry / action functions.       */
/*                                                                     */
/* Pure functions (computeDropMode / needsAutoScroll / computeDropAction */
/* ) are unit-tested in tests/dnd.test.cjs; attachRowDrag is the thin   */
/* DOM binding adapted from expanded-bookmarks' gesture state machine.  */
/* ------------------------------------------------------------------ */

import { groupContains, isGroupContainer, locateItem } from "./writeback";
import type { BookmarkItemLike, BookmarksDataLike } from "./tree";

export const DRAG_HOLD_MS = 400; // touch long-press "pick up" threshold
export const MENU_HOLD_MS = 600; // keep holding still → open the menu
export const SCROLL_SLOP = 5; // small move before pick-up = scrolling
export const TOUCH_DRAG_SLOP = 10; // touch drag start threshold
export const MOUSE_DRAG_SLOP = 4; // mouse drag start threshold
export const SCROLL_EDGE = 36; // px from list edge that triggers auto-scroll
export const SCROLL_STEP = 12; // px per frame
/** Auto-reset window: a click-suppression left unconsumed this long is cleared. */
export const CLICK_SUPPRESS_RESET_MS = 500;

export type DropMode = "before" | "into" | "after";

export interface DropAction {
	ok: boolean;
	reason?:
		| "not-found"
		| "self"
		| "no-target"
		| "target-not-found"
		| "not-group"
		| "same-container"
		| "group-descendant"
		| "legacy-group-into"
		| "legacy-group-cross";
	/** Destination container (group item) or null = root list. */
	target: BookmarkItemLike | null;
	/** Insertion index within the target list; undefined = append. */
	index?: number;
}

/**
 * Drop zone on a row: groups have three zones (before / into / after),
 * other rows split in half. `clientY` outside the row → null.
 */
export function computeDropMode(
	rect: { top: number; height: number },
	clientY: number,
	isGroup: boolean
): DropMode | null {
	if (!rect || !(rect.height > 0)) return null;
	const y = (clientY - rect.top) / rect.height;
	if (y < 0 || y > 1) return null;
	if (isGroup) {
		if (y < 0.25) return "before";
		if (y > 0.75) return "after";
		return "into";
	}
	return y <= 0.5 ? "before" : "after";
}

/** Auto-scroll direction when the pointer is near the list edges. */
export function needsAutoScroll(
	listRect: { top: number; bottom: number },
	y: number,
	edge: number = SCROLL_EDGE
): "up" | "down" | null {
	if (y < listRect.top + edge) return "up";
	if (y > listRect.bottom - edge) return "down";
	return null;
}

/**
 * Compute where a dropped item should land (validates + resolves the
 * destination). Does NOT mutate. Mode "top" = drop on empty list area →
 * move out of any group to the top level (append). `index` is the
 * insertion index in the target list; moveItemInData adjusts it when the
 * source and target lists are the same.
 */
export function computeDropAction(
	data: BookmarksDataLike,
	dragItem: BookmarkItemLike,
	targetItem: BookmarkItemLike | null,
	mode: DropMode | "top"
): DropAction {
	if (mode === "top") {
		return { ok: true, target: null, index: undefined };
	}
	if (!targetItem) return { ok: false, reason: "no-target", target: null };
	if (targetItem === dragItem) return { ok: false, reason: "self", target: null };
	const dragLoc = locateItem(data, (it) => it === dragItem);
	if (!dragLoc) return { ok: false, reason: "not-found", target: null };

	if (mode === "into") {
		if (!isGroupContainer(targetItem)) return { ok: false, reason: "not-group", target: null };
		if (dragLoc.legacyGroup) return { ok: false, reason: "legacy-group-into", target: null };
		// Already directly inside the target group → nothing to do.
		if (dragLoc.parentList === targetItem.items) return { ok: false, reason: "same-container", target: null };
		// A group must not be dropped into itself or one of its descendants.
		if (isGroupContainer(dragItem) && groupContains(dragItem, targetItem)) {
			return { ok: false, reason: "group-descendant", target: null };
		}
		return { ok: true, target: targetItem, index: undefined };
	}

	// before / after
	const tLoc = locateItem(data, (it) => it === targetItem);
	if (!tLoc) return { ok: false, reason: "target-not-found", target: null };
	if (isGroupContainer(dragItem) && groupContains(dragItem, targetItem)) {
		return { ok: false, reason: "group-descendant", target: null };
	}
	if (dragLoc.legacyGroup) {
		// Legacy group entries only reorder within data.groups (top level).
		if (!tLoc.legacyGroup) return { ok: false, reason: "legacy-group-cross", target: null };
		return { ok: true, target: null, index: tLoc.index + (mode === "after" ? 1 : 0) };
	}
	if (tLoc.legacyGroup) {
		// A regular item dropped next to a legacy group row → top level,
		// after everything (top-level items render before legacy groups).
		return { ok: true, target: null, index: undefined };
	}
	const targetContainer = tLoc.groupPath[tLoc.groupPath.length - 1] ?? null;
	return { ok: true, target: targetContainer, index: tLoc.index + (mode === "after" ? 1 : 0) };
}

/**
 * Decide what a pointer-end event produces. A `cancel` always ends the
 * gesture WITHOUT a drop (system gesture takeover / incoming call — the
 * last coordinates are meaningless); an `up` drops only when the drag was
 * active and the pointer ended over a real target.
 */
export function resolvePointerEnd(
	kind: "up" | "cancel",
	active: boolean,
	target: DropTarget
): DropTarget | null {
	if (kind === "cancel") return null;
	if (!active || target.kind === "none") return null;
	return target;
}

/**
 * One-shot "suppress the next click" flag with an automatic reset: if the
 * flag is not consumed (a row guard swallowing the synthetic click) within
 * `resetMs`, it clears itself. This prevents a stale flag — left behind
 * when a drag's re-render removed the row that would have consumed the
 * synthesized click — from swallowing an unrelated later row click.
 * Timers are injected so the state machine is unit-testable without a DOM.
 */
export class ClickSuppressor {
	private active = false;
	private timer: number | null = null;

	constructor(
		private readonly resetMs: number,
		private readonly schedule: (fn: () => void, ms: number) => number,
		private readonly cancel: (id: number) => void
	) {}

	isActive(): boolean {
		return this.active;
	}

	/** Arm (true) or clear (false) the suppression; arming restarts the reset window. */
	setActive(v: boolean): void {
		this.active = v;
		if (this.timer !== null) {
			this.cancel(this.timer);
			this.timer = null;
		}
		if (v && this.resetMs > 0) {
			this.timer = this.schedule(() => {
				this.timer = null;
				this.active = false;
			}, this.resetMs);
		}
	}

	/** Consume the flag; true = this click must be swallowed. */
	consume(): boolean {
		if (!this.active) return false;
		this.active = false;
		if (this.timer !== null) {
			this.cancel(this.timer);
			this.timer = null;
		}
		return true;
	}
}

/* ------------------------------------------------------------------ */
/* DOM gesture state machine                                          */
/* ------------------------------------------------------------------ */

export type DropTarget =
	| { kind: "row"; row: HTMLElement; mode: DropMode }
	| { kind: "empty" } // whitespace inside the list → move to top level
	| { kind: "none" };

/** Shared across rows so main.ts can ignore touch-synthesized contextmenus. */
export interface DragGestureState {
	lastTouchAt: number;
}

export interface RowDragOptions {
	/** The scrollable list container (.phb-popover-list). */
	listEl: HTMLElement;
	/** Whether the row is a real bookmark row (drag source / drop target). */
	isBookmarkRow?: (row: HTMLElement) => boolean;
	isGroupRow?: (row: HTMLElement) => boolean;
	/** Touch long-press (no move) → open the item menu at this position. */
	onMenu?: (pos: { x: number; y: number }) => void;
	/** A completed drag with a resolved drop target. */
	onDrop?: (target: DropTarget) => void;
	onDragChange?: (active: boolean) => void;
}

export function attachRowDrag(row: HTMLElement, opts: RowDragOptions, state: DragGestureState): void {
	let drag: {
		pointerId: number;
		startX: number;
		startY: number;
		armed: boolean;
		active: boolean;
		menuShown: boolean;
	} | null = null;
	let pressTimer: number | null = null;
	let menuTimer: number | null = null;

	const isBookmark = opts.isBookmarkRow ?? ((): boolean => true);
	const isGroup = opts.isGroupRow ?? ((r: HTMLElement) => r.classList.contains("phb-item-group"));

	const clearTimers = (): void => {
		if (pressTimer !== null) {
			window.clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (menuTimer !== null) {
			window.clearTimeout(menuTimer);
			menuTimer = null;
		}
	};

	const clearDropMarks = (): void => {
		for (const el of Array.from(opts.listEl.querySelectorAll(".phb-item"))) {
			el.classList.remove("phb-drop-into", "phb-drop-above", "phb-drop-below");
		}
	};

	const dropTargetAt = (e: PointerEvent): DropTarget => {
		const d = drag;
		if (!d) return { kind: "none" };
		const under = document.elementFromPoint(e.clientX, e.clientY);
		const hit = under instanceof HTMLElement ? under.closest(".phb-item") : null;
		if (!(hit instanceof HTMLElement)) {
			const inList = under instanceof HTMLElement && under.closest(".phb-popover-list") !== null;
			return inList ? { kind: "empty" } : { kind: "none" };
		}
		if (hit === row) return { kind: "none" };
		if (!isBookmark(hit)) return { kind: "none" };
		const rect = hit.getBoundingClientRect();
		const mode = computeDropMode(rect, e.clientY, isGroup(hit));
		if (!mode) return { kind: "none" };
		return { kind: "row", row: hit, mode };
	};

	const showDropTarget = (e: PointerEvent): void => {
		clearDropMarks();
		const hit = dropTargetAt(e);
		if (hit.kind !== "row") return;
		if (hit.mode === "into") hit.row.classList.add("phb-drop-into");
		else if (hit.mode === "after") hit.row.classList.add("phb-drop-below");
		else hit.row.classList.add("phb-drop-above");
	};

	const autoScroll = (e: PointerEvent): void => {
		const list = opts.listEl;
		const rect = list.getBoundingClientRect();
		const dir = needsAutoScroll(rect, e.clientY);
		if (dir === "up") list.scrollTop -= SCROLL_STEP;
		else if (dir === "down") list.scrollTop += SCROLL_STEP;
	};

	const endDrag = (): void => {
		clearTimers();
		document.removeEventListener("pointermove", onPointerMove);
		document.removeEventListener("pointerup", onPointerUp);
		document.removeEventListener("pointercancel", onPointerCancel);
		document.removeEventListener("touchmove", onTouchMove);
		if (drag) {
			row.classList.remove("phb-item-dragging", "phb-press");
			opts.listEl.classList.remove("phb-drag-active");
			opts.onDragChange?.(false);
		}
		clearDropMarks();
		drag = null;
	};

	const onTouchMove = (e: TouchEvent): void => {
		// Scrolling can only be stopped from touchmove: preventDefault on
		// pointermove does nothing once the browser owns the gesture.
		if (drag?.armed) e.preventDefault();
	};

	const onPointerMove = (e: PointerEvent): void => {
		const d = drag;
		if (!d || e.pointerId !== d.pointerId) return;
		if (d.menuShown) return;
		const dist = Math.max(Math.abs(e.clientX - d.startX), Math.abs(e.clientY - d.startY));
		if (!d.active) {
			// Sliding before the row is picked up = scrolling, not dragging.
			if (!d.armed) {
				if (dist > SCROLL_SLOP) endDrag();
				return;
			}
			if (dist <= (e.pointerType === "mouse" ? MOUSE_DRAG_SLOP : TOUCH_DRAG_SLOP)) return;
			if (menuTimer !== null) {
				window.clearTimeout(menuTimer);
				menuTimer = null;
			}
			d.active = true;
			row.classList.add("phb-item-dragging");
			opts.listEl.classList.add("phb-drag-active");
			opts.onDragChange?.(true);
		}
		e.preventDefault();
		showDropTarget(e);
		autoScroll(e);
	};

	const onPointerUp = (e: PointerEvent): void => {
		const d = drag;
		if (!d) return;
		const dropped = resolvePointerEnd("up", d.active, dropTargetAt(e));
		endDrag();
		if (dropped) opts.onDrop?.(dropped);
	};

	const onPointerCancel = (): void => {
		if (!drag) return;
		// System gesture takeover (touch) / call etc.: end the gesture
		// WITHOUT dropping — the cancel event's last coordinates are
		// meaningless and must not move a bookmark.
		endDrag();
	};

	const onPointerDown = (e: PointerEvent): void => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		if ((e.target as HTMLElement | null)?.closest("input, button")) return;
		const byTouch = e.pointerType !== "mouse";
		if (byTouch) state.lastTouchAt = Date.now();
		drag = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			armed: !byTouch,
			active: false,
			menuShown: false,
		};
		if (byTouch) {
			pressTimer = window.setTimeout(() => {
				pressTimer = null;
				if (!drag) return;
				drag.armed = true;
				row.classList.add("phb-press");
				// Block touch scrolling from here on, not once movement starts.
				opts.listEl.classList.add("phb-drag-active");
			}, DRAG_HOLD_MS);
			menuTimer = window.setTimeout(() => {
				menuTimer = null;
				const d = drag;
				if (!d || d.active || !opts.onMenu) return;
				d.menuShown = true;
				opts.onMenu({ x: e.clientX, y: e.clientY });
			}, MENU_HOLD_MS);
		}
		document.addEventListener("pointermove", onPointerMove, { passive: false });
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("pointercancel", onPointerCancel);
		if (byTouch) document.addEventListener("touchmove", onTouchMove, { passive: false });
	};

	row.addEventListener("pointerdown", onPointerDown);
}
