1. Open [MessageView.tsx](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) and inspect the markdown styles.
2. Confirm `.markdown code` defines the inline-code font and size but does not set any wrapping behavior such as `overflow-wrap`, `word-break`, `word-wrap`, or `white-space`.
3. Confirm the chat bubble wrapper in the same file uses `'max-width': '85%'` and `overflow: 'hidden'`.
4. Because Feather renders transcript markdown through that same component, any sufficiently long inline code span can grow wider than the mobile bubble and get clipped instead of wrapping.
5. The filed repro screenshot in [inline-code-overflow.png](/home/user/feather-dev/w5/issues/20260325-085719-inline-code-overflows-mobile-chat/inline-code-overflow.png) shows that exact failure on the `hello old friend` mobile transcript.
