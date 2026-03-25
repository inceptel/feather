1. Open [/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx).
2. Inspect the `tool_use` block renderer in the `<summary>` for tool cards.
3. Confirm the header renders the tool label in one `<span>` and the file path or command summary in a second `<span>` with only `'margin-left': '8px'` between them.
4. Because there is no textual separator, copied or accessibility text collapses into strings like `Editconf.d/supervisord.conf` and `Bashecho ...`, which matches the reported mobile bug.
5. Run `bash issues/20260325-110133-tool-card-labels-run-together/replicate.sh`. It exits `0` while that concatenated-label pattern is present and `1` once the header includes a real separator.
