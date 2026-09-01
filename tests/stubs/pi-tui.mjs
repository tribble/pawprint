// Stub for runtime imports from @earendil-works/pi-tui. Functional no-ops;
// SelectList records its items so tests can drive onSelect/onCancel.
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
export class SelectList {
  constructor(items) {
    this.items = items;
    this.onSelect = null;
    this.onCancel = null;
  }
  handleInput() {}
}
export const Key = {
  ctrlShift: (c) => `ctrl+shift+${c}`,
};
