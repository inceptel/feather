1. Open [frontend/src/App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and find the mobile view switcher.
2. Confirm the `Terminal` control is still a plain button: `<button onClick={() => setTab('terminal')} ...>Terminal</button>`.
3. In that same file, confirm the terminal pane is rendered in place with `<Terminal sessionId={tab() === 'terminal' ? currentId() : null} />`.
4. Open [frontend/src/components/Terminal.tsx](/home/user/feather-dev/w5/frontend/src/components/Terminal.tsx) and confirm the component opens a WebSocket to `/new-dev/api/terminal?session=...` rather than navigating the page.
5. Search those two files for `chrome://new-tab-page/`, `window.open(`, and `location.href` / `location.assign` / `location.replace`.
6. The bug is absent in the current build if the source still matches those checks, because the Terminal tab only toggles app state and mounts the embedded terminal component instead of opening a browser tab.
