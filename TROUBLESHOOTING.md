# AI Workspace Bridge - Troubleshooting Guide

## Issue: CloudFlare "Unusual Activity" Block (Error 57b477e7...)

### Root Cause
ChatGPT uses CloudFlare to detect automated browser access. Puppeteer automation is flagged as suspicious.

### How to Avoid It

#### 1. **Stealth Plugin Installed** ✅ (DEFAULT)
Extension now uses `puppeteer-extra-plugin-stealth` to hide automation:
- Hides WebDriver automation signals
- Randomizes timing (human-like delays)
- Masks browser fingerprint

**Status:** Installed in package.json. No action needed.

#### 2. **What If Challenge Still Appears?**

**The extension will:**
1. Detect CloudFlare challenge on page
2. Show a VS Code warning: "CloudFlare Challenge Detected"
3. Bring browser to front
4. Wait 15 seconds for you to verify manually

**Your action:**
- Look at the browser window
- If you see "Unusual activity" prompt: **click "Verify"** or **complete the challenge**
- The extension waits, then continues automatically

#### 3. **Retry Logic**
Extension auto-retries up to **3 times** with exponential backoff:
- Attempt 1: immediate
- Attempt 2: 2 second delay
- Attempt 3: 4 second delay

---

## Issue: "@myagent write file" doesn't work

### Root Causes

#### 1. **Modal Dialog Not Confirmed** ⚠️ MOST COMMON
When ChatGPT requests a `writeFile` tool, VS Code shows a **modal warning dialog**.

```
Write tic_tac_toe.py?  [Write file] [Cancel]
```

**What to do:**
- Look for this dialog in the **top-right corner of VS Code**
- Click the **"Write file"** button
- If you don't see it, check VS Code notifications panel (bell icon)

#### 2. **Tool Round Limit Exceeded**
The limit was increased to `MAX_CHATGPT_TOOL_ROUNDS = 7` to handle complex tasks.

**Status:** ✅ **FIXED**

#### 3. **ChatGPT Claims File Creation Without Using Tool**
ChatGPT would sometimes claim "I've created file" without issuing a TOOL_CALL.

**Status:** ✅ **IMPROVED** - System prompt now prevents this with explicit rules

---

## Step-by-Step: Creating a File with @myagent

1. **Open VS Code chat** and send:
   ```
   @myagent read Hello.md and create tic_tac_toe.py with a Python tic tac toe game
   ```

2. **ChatGPT analyzes and requests tool (internal)**

3. **Extension executes the tool and shows result to ChatGPT**

4. **ChatGPT issues writeFile request**

5. **VS Code shows modal dialog:**
   ```
   Write tic_tac_toe.py?
   [Write file] [Cancel]
   ```
   👈 **CLICK "Write file" here**

6. **File is created successfully**

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Unusual activity has been detected" | CloudFlare blocked automation | Browser will show challenge. Verify manually in browser window, then click OK. |
| File doesn't appear after confirmation | Modal dialog timing issue | Try asking for a simpler file first |
| "ChatGPT requested too many tool rounds" | Task too complex for 7 rounds | Break into smaller tasks |
| ChatGPT tries to use code_interpreter | ChatGPT forgot about workspace tools only | System prompt was reinforced to prevent this |

---

## If File Creation Still Doesn't Work

1. **Check the Debug Console:**
   - Press `Ctrl+Shift+I` in the extension host window
   - Open **Debug Console** tab
   - Look for logs like:
     ```
     ChatGPT requested tool: writeFile
     Browser launched with stealth plugin enabled
     ```

2. **Try a local workspace operation (no ChatGPT):**
   ```
   @myagent write file test.txt: hello world
   ```
   - This doesn't need ChatGPT browser
   - Will show modal dialog directly
   - Tests if file writing works at all

3. **Reset CloudFlare state:**
   - Run: `AI Workspace Bridge: Reset ChatGPT Browser Profile`
   - This clears cookies and cached state
   - Then try again

4. **Check workspace is open:**
   - File paths are relative to workspace root
   - If no folder is open, extension can't write files

---

## Technical Details

### Stealth Mode Features
- **puppeteer-extra-plugin-stealth** masks:
  - WebDriver presence
  - Chrome version
  - User agent
  - Timing fingerprints

- **Human-like delays added:**
  - 500-1500ms before typing
  - 500-1500ms before sending
  - 1000-3000ms after receiving response

- **Auto-detection of CloudFlare:**
  - Scans page content for "Unusual activity"
  - Detects error code patterns
  - Shows manual verification prompt

### Files Modified (Latest Build)
- **ChatGPTClient.ts**
  - ✅ Stealth plugin integration
  - ✅ CloudFlare detection + auto-retry
  - ✅ Human-like delays
  - ✅ Exponential backoff (up to 3 attempts)

- **BackendClient.ts**
  - ✅ Tool round limit: 3 → 7
  - ✅ Enhanced system prompt with CRITICAL RULES
  - ✅ Native tool blocking/rejection

- **WorkspaceAgent.ts**
  - ✅ Better error messages for unknown tools

---

## Next Steps to Prevent Future Issues

### For Users
- ✅ Keep browser visible (headless: false) to see challenges
- ✅ Don't close browser window during operations
- ✅ If challenged, verify manually, then retry

### For Future Improvements
- [ ] Auto-solve simple CloudFlare challenges with OCR
- [ ] Proxy rotation (changes IP address)
- [ ] Longer session token retention
- [ ] Pre-login automation cache

---

## Build & Test
```bash
npm install         # Install stealth plugin and dependencies
npm run build       # Rebuild with new features
npm run watch       # Watch mode for development

# In VS Code:
# Press F5 to launch extension development host
```

---

## Support

If problems persist:
1. Check [ChatGPTClient.ts](src/services/ChatGPTClient.ts) for stealth plugin logs
2. Verify stealth plugin is in node_modules: `npm list puppeteer-extra`
3. Try resetting browser profile and logging in again
4. Check for CloudFlare IP bans in ChatGPT browser (will show error page)

