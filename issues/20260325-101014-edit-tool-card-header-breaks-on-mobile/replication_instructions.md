1. Open [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) and inspect the `toolSummary()` logic for `Edit`.
2. Confirm the `Edit` branch appends ` ×all` directly onto the shortened file path, producing a single summary string such as `conf.d/supervisord.conf ×all`.
3. Confirm the `<summary>` renderer outputs that entire summary inside one gray `<span>` with only `margin-left: 8px` and no `white-space: nowrap` protection for the modifier.
4. On a 390px-wide mobile card, that combined summary is allowed to wrap, so the `×all` modifier can fall onto its own orphaned line, matching the filed screenshot.
5. Run `bash issues/20260325-101014-edit-tool-card-header-breaks-on-mobile/replicate.sh`; it exits `0` while that source-backed mobile-breaking pattern is still present.
