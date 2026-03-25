1. Open Feather on mobile at `390x844` with a session selected so the header shows the `Chat` and `Terminal` view switchers.
2. Inspect those two controls in the DOM or accessibility tree.
3. Switch between `Chat` and `Terminal` and inspect again.
4. The bug is present if Feather exposes the switcher as two plain `button` elements instead of a tab interface: no parent `tablist`, no `role="tab"`, and no `aria-selected` or `aria-controls` state on either control.
