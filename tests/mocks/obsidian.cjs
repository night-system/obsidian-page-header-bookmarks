/* ------------------------------------------------------------------ */
/* Minimal obsidian runtime stub used ONLY by unit tests that bundle   */
/* src/menu.ts (esbuild --alias:obsidian=<this file>). Tests never     */
/* open modals / menus, so every member is a no-op stub.               */
/* ------------------------------------------------------------------ */

"use strict";

class Menu {
	constructor() {
		this.items = [];
	}
	addItem(cb) {
		const item = {
			setTitle() {
				return this;
			},
			setIcon() {
				return this;
			},
			setClass() {
				return this;
			},
			onClick(fn) {
				this._onClick = fn;
				return this;
			},
		};
		cb(item);
		this.items.push(item);
		return this;
	}
	addSeparator() {
		this.items.push({ separator: true });
		return this;
	}
	onHide() {
		return this;
	}
	showAtPosition() {}
	showAtMouseEvent() {}
}

class Modal {
	constructor(app) {
		this.app = app;
		this.containerEl = {};
		this.contentEl = {};
	}
	open() {}
	close() {}
	setTitle() {}
}

class FuzzySuggestModal {
	constructor(app) {
		this.app = app;
	}
	open() {}
	close() {}
	setPlaceholder() {}
}

class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
	}
	addText(cb) {
		const t = {
			value: "",
			setValue(v) {
				this.value = v;
				return this;
			},
			onChange(fn) {
				this._onChange = fn;
				return this;
			},
			inputEl: { focus() {}, select() {}, addEventListener() {} },
		};
		cb(t);
		return this;
	}
	addButton(cb) {
		const b = {
			setButtonText(s) {
				this.text = s;
				return this;
			},
			setCta() {
				return this;
			},
			setWarning() {
				return this;
			},
			onClick(fn) {
				this._onClick = fn;
				return this;
			},
		};
		cb(b);
		return this;
	}
}

module.exports = { Menu, Modal, FuzzySuggestModal, Setting };
