# Fix Whitelist Bug & YouTube Ad-Skip Glitch



You are debugging and fixing an existing Manifest V3 Chrome ad-blocker extension. Two specific bugs need to be fixed properly, with root-cause analysis, not quick patches. Review the existing code fully before changing anything, then fix as described below.

---

### BUG 1: Whitelist Manager does not actually stop ads on whitelisted sites

**Symptom**: Adding a domain to the whitelist in the options page does not disable ad/tracker blocking on that domain — ads still appear.

**Likely root causes to investigate and fix**:

1. **Whitelist check is missing at the `declarativeNetRequest` level.** Static rulesets (`ad-rules.json`, `tracker-rules.json`) apply globally to every tab regardless of whitelist state, because DNR rules don't automatically know about your whitelist — you must explicitly exclude whitelisted domains. Fix this using one of these correct approaches:
   - **Preferred**: Use `chrome.declarativeNetRequest.updateSessionRules` (or per-tab dynamic rules) to add a **higher-priority "allow" rule** for whitelisted domains that overrides the block rules. An `action: { type: "allow" }` rule with higher `priority` than your block rules will let matching requests through. Regenerate/update these allow-rules every time the whitelist changes (add on whitelist-add, remove on whitelist-remove).
   - **Alternative**: If using `updateEnabledRulesets`, note that this disables rules extension-wide, not per-domain — this is likely the wrong tool for per-site whitelisting and may be the actual bug if it's currently being used this way. Replace it with the allow-rule approach above.

2. **Whitelist check is missing in content scripts.** Even if network-level blocking is fixed, `general-blocker.js`, `cosmetic-filters.css` injection, and `youtube-blocker.js` also need to check the whitelist **before running any blocking logic**:
   - At the very top of each content script, before any `MutationObserver` or DOM manipulation runs, query `chrome.storage.sync` (or wherever the whitelist is stored) for the current page's hostname
   - If the hostname (or a matching parent domain, e.g., `example.com` should match `www.example.com` and `sub.example.com` if that's the intended behavior — clarify and implement consistent domain-matching logic, e.g., suffix matching) is in the whitelist, **exit the script immediately** and do not inject any cosmetic CSS, do not run any observers, do not modify the DOM at all
   - Also make sure `cosmetic-filters.css` (if injected via `chrome.scripting.insertCSS` rather than a static content script) is conditionally inserted only for non-whitelisted sites — check before insertion, and if already injected on a page that gets whitelisted mid-session, remove it via `chrome.scripting.removeCSS`

3. **Timing/race condition check**: confirm the whitelist check happens synchronously enough relative to `document_start` — if using `chrome.storage.sync.get` (async), make sure blocking logic actually **waits** for the storage callback/promise to resolve before running, rather than firing blocking logic immediately and checking whitelist status afterward (which would cause a flash-then-remove behavior, not true prevention).

4. **Update the popup and options UI** to reflect real-time whitelist status — if a user is currently on a whitelisted site, the popup toggle should visibly show "Disabled for this site" so it's clear the whitelist is actually being read correctly, rather than silently doing nothing.

5. **Domain matching correctness**: write and test a pure function `isWhitelisted(hostname, whitelistArray)` that correctly handles:
   - Exact matches (`example.com` in list, page is `example.com`)
   - Subdomain matches (`example.com` in list, page is `m.example.com` or `www.example.com`)
   - Make sure it does NOT accidentally match unrelated domains that merely contain the whitelisted string (e.g., whitelisting `example.com` must NOT match `notexample.com` or `example.com.evil.net`) — use proper hostname-suffix comparison (`hostname === domain || hostname.endsWith('.' + domain)`), not naive `.includes()`

**Deliverable for Bug 1**: Show me the corrected whitelist-checking logic across `background.js`, all content scripts, and the DNR rule-update logic, plus the new/fixed `isWhitelisted()` utility function. Explain in comments exactly what was wrong before (if identifiable from the existing code) and why the new approach fixes it.

---

### BUG 2: YouTube ad-skipping causes a black-screen freeze (1 sec ad flash → 5-10 sec black screen → resume)

**Symptom**: When an ad starts, the current script briefly shows the ad (~1 sec), then the video goes to a black screen and freezes for 5-10 seconds before resuming actual content. This is a bad user experience — the goal is either a clean instant skip or, at minimum, no black-screen freeze.

**Root cause analysis (likely one or more of these)**:

1. **Fast-forwarding `currentTime` to `duration` on an ad element that hasn't finished loading/buffering** causes YouTube's player to stall while it tries to catch up buffering or re-fetch the real video's manifest, causing the freeze. Jumping straight to `duration` is often too abrupt and fights against YouTube's own player state machine.

2. **The script may be detecting `.ad-showing` class AFTER the ad has already started playing** (1 sec into it) rather than the moment the ad container appears, meaning the "skip" happens mid-playback rather than pre-empting it — causing the visible flash before the skip logic kicks in.

3. **Conflicting/duplicate skip logic running simultaneously** (e.g., both a `currentTime` manipulation AND an auto-click on the Skip button firing at the same time) can cause YouTube's player to receive contradictory state changes, causing it to stall while resolving them.

4. **MutationObserver may be too broad/expensive**, causing delayed callback execution during high DOM-churn moments (like ad transitions), which delays the skip trigger past the ideal moment.

**Required fix approach — implement ALL of these, don't just patch symptoms:**

1. **Detect ads at the earliest possible DOM signal**, not after they're already visibly playing. Watch specifically for:
   - The ad-overlay container being *added* to the DOM (via `MutationObserver` on `childList` of the player container), not just checking `classList.contains('ad-showing')` on an interval/loop
   - YouTube's internal ad-related events if accessible (e.g., listening for changes on `.video-ads` container, `ytp-ad-player-overlay` appearing) — prioritize event-driven detection over polling

2. **Prefer clicking the native "Skip Ad" button over manipulating `currentTime` whenever the skip button is present and clickable.** This is the least disruptive method since it uses YouTube's own intended skip mechanism, avoiding player-state conflicts entirely. Only fall back to `currentTime` manipulation for **unskippable** ads where no skip button will ever appear.

3. **For unskippable ads where `currentTime` manipulation is unavoidable**:
   - Do NOT jump straight to `duration`. Instead, mute the ad audio immediately (`video.muted = true`) and set `video.playbackRate` to a very high value (e.g., `16`) temporarily to fast-forward through it smoothly, then reset `playbackRate` back to `1` and `muted` back to its prior state once the ad ends (detected via the ad container being removed from DOM, or the `ended` event firing on an ad-context video element)
   - This avoids the jarring seek-and-rebuffer freeze because the player continues playing continuously (just very fast) rather than doing a discontinuous seek

4. **Ensure only ONE skip strategy runs at a time** — add a simple state flag/lock (e.g., `let adHandlingInProgress = false`) so the skip-button-click path and the playback-rate path don't both fire on the same ad simultaneously. Clear the lock when the ad container is confirmed removed from the DOM.

5. **Debounce/throttle the MutationObserver callback** slightly (a few milliseconds) so it doesn't fire excessively during the rapid DOM churn of an ad transition, while still remaining fast enough to catch ad start within one animation frame ideally.

6. **Add explicit logging (dev-mode only, toggled via a config flag) at each stage**: "Ad detected," "Skip button clicked," "Using playback-rate fallback," "Ad ended, restoring normal playback" — so if the glitch persists, we can see exactly which code path is triggering and at what timestamp, making it easier to diagnose further if this fix doesn't fully resolve it.

7. **Test explicitly for YouTube's SPA navigation**: since YouTube doesn't do full page reloads between videos, make sure the ad-detection observer and state flags are properly reset/reattached on `yt-navigate-finish`, not left in a stale state from the previous video (a stale `adHandlingInProgress = true` lock from a previous video could itself cause a freeze on the next video).

**Deliverable for Bug 2**: Provide the complete rewritten `youtube-blocker.js` implementing the detection-first, skip-button-preferred, playback-rate-fallback approach described above, with the state lock and SPA-navigation reset handled correctly. Include inline comments explaining why each part avoids the freeze (e.g., "we use playbackRate instead of seeking directly to avoid buffer-stall on discontinuous seeks").

---

### General instructions for both fixes

- Do not introduce new unrelated features — this is a stabilization pass only
- After fixing, provide a short before/after summary explaining what was actually wrong (root cause) and what specifically changed to fix it, for both bugs
- Flag any remaining edge cases you're not fully confident are fixed (e.g., "mid-roll ads on longer videos may behave slightly differently — please test and report back")
- Since YouTube changes its ad-delivery DOM/behavior periodically, note clearly in code comments which specific class names/selectors this fix currently depends on, so future maintenance is easier when YouTube changes something again

### Deliverable format
Provide:
1. Root cause explanation for both bugs based on reviewing the existing code
2. Fixed code for all affected files (whitelist logic across background.js/content scripts, and the full rewritten youtube-blocker.js)
3. A manual testing checklist specific to verifying both fixes (whitelist toggling on/off across a few real sites, and YouTube ad behavior across pre-roll/mid-roll/unskippable ad types)


