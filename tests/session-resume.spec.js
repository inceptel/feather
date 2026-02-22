/**
 * Session Resume Bug Test
 *
 * Tests that clicking on an existing session actually resumes it
 * with the --resume flag, rather than starting a fresh Claude instance.
 *
 * BUG: Sessions with only file-history-snapshot entries (no actual messages)
 * are displayed in the sidebar, but clicking them causes Claude to fail
 * with "No conversation found" and the tmux session dies immediately.
 *
 * Run with: npx playwright test tests/session-resume.spec.js
 */

const { test, expect } = require('@playwright/test');

// Direct container access (bypasses Authelia)
const BASE_URL = process.env.FEATHER_URL || 'http://localhost:8199';

test.describe('Session Resume Bug', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await page.waitForSelector('h1:has-text("Feather")', { timeout: 15000 });
        await page.waitForSelector('#sessions', { timeout: 5000 });
    });

    test('should only show sessions with actual messages in API response', async ({ page, request }) => {
        // After fix: API should only return sessions that have normalized content
        const projectsRes = await request.get(`${BASE_URL}/api/projects`);
        const projects = await projectsRes.json();

        if (!projects.projects || projects.projects.length === 0) {
            test.skip();
            return;
        }

        const projectId = projects.projects[0].id;
        const sessionsRes = await request.get(`${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions`);
        const sessionsData = await sessionsRes.json();

        console.log(`API returned ${sessionsData.sessions?.length || 0} sessions`);

        // Every session returned by the API should have real messages
        for (const session of (sessionsData.sessions || []).slice(0, 5)) {
            const historyRes = await request.get(
                `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${session.id}/history`
            );
            const history = await historyRes.json();

            const hasRealMessages = history.messages &&
                history.messages.length > 0 &&
                !history.messages.some(m => m.uuid === 'unsupported-session');

            console.log(`Session ${session.id}: hasRealMessages=${hasRealMessages}, messageCount=${history.messages?.length || 0}`);

            // After fix: all sessions returned by API should have real messages
            expect(hasRealMessages, `Session ${session.id} should have real messages`).toBe(true);
        }
    });

    test('should spawn tmux session that stays alive when resuming valid session', async ({ page, request }) => {
        // First, find a session that has actual messages
        const projectsRes = await request.get(`${BASE_URL}/api/projects`);
        const projects = await projectsRes.json();

        if (!projects.projects || projects.projects.length === 0) {
            test.skip();
            return;
        }

        const projectId = projects.projects[0].id;
        const projectPath = projects.projects[0].path;
        const sessionsRes = await request.get(`${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions`);
        const sessionsData = await sessionsRes.json();

        // Find a session with actual messages
        let validSession = null;
        for (const session of (sessionsData.sessions || [])) {
            const historyRes = await request.get(
                `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${session.id}/history`
            );
            const history = await historyRes.json();

            const hasRealMessages = history.messages &&
                history.messages.length > 0 &&
                !history.messages.some(m => m.uuid === 'unsupported-session');

            if (hasRealMessages) {
                validSession = session;
                break;
            }
        }

        if (!validSession) {
            console.log('No session with real messages found - skipping');
            test.skip();
            return;
        }

        console.log(`Testing resume with valid session: ${validSession.id}`);

        // Spawn the session
        const spawnRes = await request.post(`${BASE_URL}/api/claude-spawn/${validSession.id}`, {
            data: { cwd: projectPath }
        });
        const spawnData = await spawnRes.json();

        expect(spawnData.status).toBe('spawned');
        expect(spawnData.tmux_name).toContain('feather-');
        expect(spawnData.tmux_name).not.toContain('-new-');

        // Wait for Claude to start
        await page.waitForTimeout(3000);

        // Check that the tmux session is still alive
        const tmuxRes = await request.get(`${BASE_URL}/api/claude-sessions`);
        const tmuxData = await tmuxRes.json();

        const ourSession = tmuxData.tmux_sessions.find(s => s.name === spawnData.tmux_name);
        expect(ourSession, `Tmux session ${spawnData.tmux_name} should still be alive`).toBeTruthy();
    });

    test('empty sessions should not appear in API (fix verification)', async ({ page, request }) => {
        // After fix: API should not return sessions without real messages
        // So we can't find an "empty" session to test with - that's the fix!

        const projectsRes = await request.get(`${BASE_URL}/api/projects`);
        const projects = await projectsRes.json();

        if (!projects.projects || projects.projects.length === 0) {
            test.skip();
            return;
        }

        const projectId = projects.projects[0].id;
        const sessionsRes = await request.get(`${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions`);
        const sessionsData = await sessionsRes.json();

        // Try to find an empty session - after fix, there should be none
        let emptySessionCount = 0;
        for (const session of (sessionsData.sessions || [])) {
            const historyRes = await request.get(
                `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${session.id}/history`
            );
            const history = await historyRes.json();

            const hasRealMessages = history.messages &&
                history.messages.length > 0 &&
                !history.messages.some(m => m.uuid === 'unsupported-session');

            if (!hasRealMessages) {
                console.log(`Found empty session (should not exist after fix): ${session.id}`);
                emptySessionCount++;
            }
        }

        // After fix: no empty sessions should be returned by the API
        expect(emptySessionCount, 'No empty sessions should be returned by API').toBe(0);
    });
});
