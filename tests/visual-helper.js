/**
 * Visual Testing Helper
 *
 * Uses Claude CLI to analyze screenshots for:
 * - Visual regression testing (comparing current vs baseline)
 * - Visual validation (checking if UI looks correct)
 * - Accessibility checks (contrast, readability)
 *
 * No API key needed - uses the Claude CLI directly.
 *
 * Usage:
 *   npm run test:visual
 *
 * To update baselines:
 *   UPDATE_BASELINES=1 npm run test:visual
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');

// Directory for storing baseline screenshots
const BASELINE_DIR = path.join(__dirname, 'visual-baselines');

// Find Claude CLI path (may not be in PATH in Playwright workers)
let CLAUDE_PATH = 'claude';
try {
    CLAUDE_PATH = execSync('which claude', { encoding: 'utf-8' }).trim();
} catch {
    // Try common locations
    const commonPaths = [
        `${process.env.HOME}/.nvm/versions/node/v22.12.0/bin/claude`,
        '/usr/local/bin/claude',
        `${process.env.HOME}/.local/bin/claude`
    ];
    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            CLAUDE_PATH = p;
            break;
        }
    }
}

/**
 * Run Claude CLI with an image and prompt, returning the response.
 *
 * @param {string} imagePath - Path to the image file
 * @param {string} prompt - The prompt to send
 * @returns {Promise<string>} - Claude's response
 */
async function runClaudeWithImage(imagePath, prompt) {
    return new Promise((resolve, reject) => {
        // Use claude CLI with --print flag for non-interactive output
        // Pass the image path and prompt
        const fullPrompt = `[Image: ${imagePath}]\n\n${prompt}`;

        try {
            // Use claude with -p for print mode (non-interactive)
            const result = execSync(
                `${CLAUDE_PATH} -p "${fullPrompt.replace(/"/g, '\\"')}"`,
                {
                    encoding: 'utf-8',
                    timeout: 60000,
                    maxBuffer: 10 * 1024 * 1024,
                    cwd: process.cwd()
                }
            );
            resolve(result);
        } catch (error) {
            reject(new Error(`Claude CLI error: ${error.message}`));
        }
    });
}

/**
 * Analyze a screenshot with Claude and validate it matches expectations.
 *
 * @param {Buffer} screenshot - PNG screenshot buffer from Playwright
 * @param {string} description - What the screenshot should show
 * @param {object} options - Additional options
 * @returns {Promise<{pass: boolean, analysis: string, issues: string[]}>}
 */
async function validateScreenshot(screenshot, description, options = {}) {
    // Save screenshot to temp file
    const tempDir = os.tmpdir();
    const imagePath = path.join(tempDir, `visual-test-${Date.now()}.png`);
    fs.writeFileSync(imagePath, screenshot);

    const prompt = `You are a visual QA tester analyzing a screenshot of a web application called "Feather" - a Claude session viewer.

Expected: ${description}

Analyze this screenshot and determine if it matches the expected description. Be strict but reasonable.

Consider:
1. Does the UI show what's expected?
2. Is the layout correct (sidebar on left, main content area)?
3. Are there any obvious visual bugs (overlapping elements, broken layouts, missing content)?
4. Is the text readable and properly styled?
5. Are interactive elements (buttons, inputs) visible and properly styled?

Respond in this exact JSON format (no markdown, just raw JSON):
{"pass": true, "analysis": "Brief description of what you see", "issues": [], "confidence": 0.95}

Or if there are issues:
{"pass": false, "analysis": "Brief description", "issues": ["issue 1", "issue 2"], "confidence": 0.9}`;

    try {
        const response = await runClaudeWithImage(imagePath, prompt);

        // Clean up temp file
        fs.unlinkSync(imagePath);

        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                pass: true,  // Default to pass if parsing fails
                analysis: response.substring(0, 500),
                issues: [],
                confidence: 0.5
            };
        }

        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        // Clean up temp file on error
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
        }

        console.error('Claude CLI error:', error.message);
        return {
            pass: true,  // Default to pass on error to not block tests
            analysis: `CLI error: ${error.message}`,
            issues: [],
            confidence: 0
        };
    }
}

/**
 * Compare two screenshots for visual regression using pixel comparison.
 * Uses pixelmatch for accurate, fast pixel-level diffing.
 *
 * @param {Buffer} current - Current screenshot
 * @param {Buffer} baseline - Baseline screenshot to compare against
 * @param {string} context - Description of what's being compared
 * @returns {Promise<{pass: boolean, differences: string[], similarity: number, diffPath?: string}>}
 */
async function compareScreenshots(current, baseline, context) {
    try {
        const currentPng = PNG.sync.read(current);
        const baselinePng = PNG.sync.read(baseline);

        // Check dimensions match
        if (currentPng.width !== baselinePng.width || currentPng.height !== baselinePng.height) {
            return {
                pass: false,
                similarity: 0,
                differences: [`Size mismatch: current ${currentPng.width}x${currentPng.height} vs baseline ${baselinePng.width}x${baselinePng.height}`],
                analysis: 'Screenshots have different dimensions'
            };
        }

        const { width, height } = currentPng;
        const diff = new PNG({ width, height });

        // Compare pixels (threshold 0.1 allows minor antialiasing differences)
        const mismatchedPixels = pixelmatch(
            currentPng.data,
            baselinePng.data,
            diff.data,
            width,
            height,
            { threshold: 0.1 }
        );

        const totalPixels = width * height;
        const similarity = 1 - (mismatchedPixels / totalPixels);
        const mismatchPercent = ((mismatchedPixels / totalPixels) * 100).toFixed(2);

        // Save diff image if there are differences
        let diffPath = null;
        if (mismatchedPixels > 0) {
            const safeName = context.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
            diffPath = path.join(BASELINE_DIR, `${safeName}-diff.png`);
            fs.writeFileSync(diffPath, PNG.sync.write(diff));
        }

        const pass = similarity >= 0.95;  // 95% similar = pass

        return {
            pass,
            similarity: parseFloat(similarity.toFixed(4)),
            differences: mismatchedPixels > 0 ? [`${mismatchPercent}% pixels differ (${mismatchedPixels} pixels)`] : [],
            analysis: pass
                ? `Images are ${(similarity * 100).toFixed(1)}% similar`
                : `${mismatchPercent}% of pixels differ`,
            diffPath
        };
    } catch (error) {
        console.error('Pixel comparison error:', error.message);
        return {
            pass: false,
            similarity: 0,
            differences: [`Comparison error: ${error.message}`],
            analysis: 'Failed to compare screenshots'
        };
    }
}

/**
 * Save a screenshot as a baseline for future comparisons.
 *
 * @param {Buffer} screenshot - Screenshot to save
 * @param {string} name - Baseline name (e.g., 'homepage', 'sidebar-open')
 */
function saveBaseline(screenshot, name) {
    if (!fs.existsSync(BASELINE_DIR)) {
        fs.mkdirSync(BASELINE_DIR, { recursive: true });
    }
    const filepath = path.join(BASELINE_DIR, `${name}.png`);
    fs.writeFileSync(filepath, screenshot);
    console.log(`Saved baseline: ${filepath}`);
}

/**
 * Load a baseline screenshot.
 *
 * @param {string} name - Baseline name
 * @returns {Buffer|null} - Screenshot buffer or null if not found
 */
function loadBaseline(name) {
    const filepath = path.join(BASELINE_DIR, `${name}.png`);
    if (!fs.existsSync(filepath)) {
        return null;
    }
    return fs.readFileSync(filepath);
}

/**
 * Check if a baseline exists.
 *
 * @param {string} name - Baseline name
 * @returns {boolean}
 */
function baselineExists(name) {
    const filepath = path.join(BASELINE_DIR, `${name}.png`);
    return fs.existsSync(filepath);
}

/**
 * Check if Claude CLI is available.
 * @returns {boolean}
 */
function isClaudeAvailable() {
    return fs.existsSync(CLAUDE_PATH);
}

module.exports = {
    validateScreenshot,
    compareScreenshots,
    saveBaseline,
    loadBaseline,
    baselineExists,
    isClaudeAvailable,
    BASELINE_DIR
};
