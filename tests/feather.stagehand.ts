import { Stagehand } from "@browserbasehq/stagehand";

const BASE_URL = process.env.FEATHER_URL || "http://localhost:4850";

async function run() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName: "claude-sonnet-4-6",
    modelClientOptions: {
      apiKey: process.env.FEATHER_ANTHROPIC_API_KEY,
    },
    localBrowserLaunchOptions: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    },
  });

  await stagehand.init();
  const page = stagehand.context.activePage()!;

  try {
    // ===== Test 1: Page loads with sidebar and input =====
    console.log("TEST 1: Page loads correctly");
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);  // SSE keeps network alive, can't use networkidle

    const title = await page.evaluate(() => document.title);
    assert(title === "Feather", `Expected title "Feather", got "${title}"`);

    const hasInput = await page.evaluate(() => !!document.getElementById("input"));
    assert(hasInput, "Message input not found");

    const hasSendBtn = await page.evaluate(() => !!document.getElementById("send-btn"));
    assert(hasSendBtn, "Send button not found");

    console.log("  PASS: Page loads with input and send button");

    // ===== Test 2: +New creates a session and doesn't get stuck =====
    console.log("TEST 2: + Claude button creates session");
    await stagehand.act("click the + Claude button to create a new Claude session");

    // Wait for session to spawn and be selected
    await page.waitForTimeout(4000);

    // Check we're NOT stuck on "Starting session..."
    const statusText = await page.evaluate(() =>
      document.getElementById("status")?.textContent
    );
    assert(
      statusText !== "Starting session...",
      `Stuck on "Starting session..." - session creation failed`
    );
    console.log(`  Status after new session: "${statusText}"`);

    // Check terminal opened
    const terminalOpen = await page.evaluate(() =>
      document.getElementById("terminal-panel")?.classList.contains("open")
    );
    assert(terminalOpen, "Terminal panel should be open after new session");

    // Check NO random history appeared (chat should show Active Session placeholder)
    const chatHtml = await page.evaluate(() =>
      document.getElementById("message-container")?.innerHTML || ""
    );
    assert(
      chatHtml.includes("Active Session"),
      "New session should show Active Session placeholder, not random history"
    );

    console.log("  PASS: New session created, terminal open, no random history");

    // ===== Test 3: Send message and get response =====
    console.log("TEST 3: Send message gets response");

    // Don't close terminal - input should be visible above it with CSS fix
    // Type message
    await page.evaluate(() => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.value = "what is 2+2?";
      input.dispatchEvent(new Event("input"));
    });

    // Click send
    await stagehand.act("click the Send button");
    await page.waitForTimeout(1000);

    // Check user message appeared
    const chatContent = await page.evaluate(() =>
      document.getElementById("message-container")?.textContent || ""
    );
    assert(
      chatContent.includes("what is 2+2?"),
      "User message not shown in chat"
    );

    // Wait for response (up to 15s)
    let gotResponse = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      const content = await page.evaluate(() =>
        document.getElementById("message-container")?.textContent || ""
      );
      if (content.includes("4")) {
        gotResponse = true;
        break;
      }
    }
    assert(gotResponse, "Claude's response never appeared in chat");

    // Check status returned to Ready
    const finalStatus = await page.evaluate(() =>
      document.getElementById("status")?.textContent
    );
    assert(finalStatus === "Ready", `Status stuck on "${finalStatus}"`);

    console.log("  PASS: Message sent, response received in chat");

    // NOTE: Mobile viewport tests skipped - Stagehand CDP mode doesn't support
    // viewport resize. Use Playwright directly for mobile layout testing.

    // ===== Done =====
    console.log("\nALL TESTS PASSED");

  } catch (e: any) {
    console.error(`\nFAILED: ${e.message}`);
    await page.screenshot({ path: "test-failure.png" });
    console.error("  Screenshot saved to test-failure.png");
    process.exit(1);
  } finally {
    await stagehand.close();
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

run();
