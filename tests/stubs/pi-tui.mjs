// Stub for runtime imports from @earendil-works/pi-tui. Functional no-ops;
// SelectList records its items (and every instance in `selectLists`) so tests can drive
// onSelect/onCancel; its handleInput knows only enter (\r), escape (\x1b) and down (\x1b[B).
export class Container {
  constructor() {
    this.children = [];
  }
  addChild(c) {
    this.children.push(c);
  }
  render() {
    return [];
  }
  invalidate() {}
}
export class Text {
  constructor(text) {
    this.text = text;
  }
}
export class Markdown {
  constructor(text) {
    this.text = text;
  }
}
export const selectLists = [];
export class SelectList {
  constructor(items) {
    this.items = items;
    this.selectedIndex = 0;
    this.onSelect = null;
    this.onCancel = null;
    selectLists.push(this);
  }
  setSelectedIndex(i) {
    this.selectedIndex = Math.max(0, Math.min(i, this.items.length - 1));
  }
  getSelectedItem() {
    return this.items[this.selectedIndex] ?? null;
  }
  handleInput(data) {
    if (data === "\r") this.onSelect?.(this.getSelectedItem());
    else if (data === "\x1b") this.onCancel?.();
    else if (data === "\x1b[B") this.setSelectedIndex(this.selectedIndex + 1);
  }
}
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const visibleWidth = (s) => plain(s).length;
export const truncateToWidth = (s, w) => (plain(s).length <= w ? s : plain(s).slice(0, w));
export const Key = {
  ctrlShift: (c) => `ctrl+shift+${c}`,
};
