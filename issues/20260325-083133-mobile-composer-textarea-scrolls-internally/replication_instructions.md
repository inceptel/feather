1. Open `http://localhost:$PORT/#cb27b0c0-ec00-4df1-8071-f3c6e58ad5d1` in a mobile viewport (`390x844`).
2. Focus the composer textarea at the bottom of the chat.
3. Paste this draft: `first line second line third line fourth line fifth line sixth line seventh line eighth line ninth line tenth line`.
4. Observe that the textarea stops growing at about `120px` tall and becomes its own vertical scroll region.
5. Confirm the bug by checking the textarea metrics in the page: `scrollHeight` exceeds `clientHeight` for this short wrapped draft.
