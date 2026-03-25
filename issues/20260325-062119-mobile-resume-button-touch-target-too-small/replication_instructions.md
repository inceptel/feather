1. Open [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and locate the header `Resume` button rendered under `<Show when={!s().isActive}>`.
2. Read the inline style for that button.
3. Derive the button height from the explicit sizing rules: `font-size` plus vertical padding on top and bottom, or `min-height` if one is present.
4. The bug is present when that derived height is below the mobile `44px` minimum touch target.
5. On this build the button uses `padding: 4px 12px` and `font-size: 12px`, which yields an estimated height of `20px`.
