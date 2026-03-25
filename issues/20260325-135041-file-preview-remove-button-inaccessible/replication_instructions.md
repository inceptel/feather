1. Open Feather on a mobile-sized viewport such as `390x844`.
2. Enter any active chat session and attach a file so the pending file preview chip appears above the composer.
3. Inspect the circular `×` remove button rendered on that preview chip.
4. The bug is present if the remove control is only `18x18` CSS pixels and exposes no descriptive accessible name such as `Remove attachment`.
5. The included `replicate.sh` detects the current implementation directly in [`frontend/src/App.tsx`](/home/user/feather-dev/w5/frontend/src/App.tsx):280, where the preview remove button is rendered as a bare `&times;` button with `width: '18px'`, `height: '18px'`, and no `aria-label`, `aria-labelledby`, or `title`.
