1. Open `http://localhost:3305/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on a mobile viewport such as `390x844`.
2. Wait for the existing chat transcript to render and inspect the right edge of the transcript area.
3. The bug is present when the transcript uses a full-height `overflow-y: auto` scroll container but the component does not apply any scrollbar-suppression styles such as `scrollbar-width: none`, `ms-overflow-style: none`, or `::-webkit-scrollbar { display: none; }`.
4. In the current source, [`MessageView.tsx`](/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx) renders the transcript with `overflow-y: auto` and touch scrolling, so platforms with classic scrollbars can keep a persistent gutter visible on mobile.
