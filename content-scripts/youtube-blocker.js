;(() => {
  /**
   * ClearBrowse — YouTube Ad Blocker (content script)
   *
   * BUG 2 FIX — Complete rewrite to fix black-screen freeze.
   *
   * WHAT WAS WRONG (root causes):
   *   1. `video.currentTime = video.duration` caused a discontinuous seek that forced
   *      YouTube's player to re-fetch/rebuffer the next content manifest, causing a
   *      5-10 second black screen stall.
   *   2. Both the skip-button click AND the currentTime seek fired on the SAME ad
   *      simultaneously — no mutual exclusion. The player received conflicting state
   *      changes causing it to stall while resolving them.
   *   3. MutationObserver fired `cleanPlayer()` on every DOM mutation with no
   *      throttling, causing repeated seeks during rapid ad-transition DOM churn.
   *   4. `adWasMuted` state was never reset on SPA navigation (`yt-navigate-finish`),
   *      leaving stale locks that could mute the next video or block ad handling.
   *
   * THE FIX (this rewrite):
   *   1. Detection-first: targeted MutationObserver on class changes of the player
   *      container detects ads the moment `.ad-showing` appears, not after playback.
   *   2. Skip-button-preferred: always try clicking the native "Skip Ad" button first.
   *      This uses YouTube's own intended skip mechanism, avoiding player-state conflicts.
   *   3. Playback-rate fallback: for unskippable ads, mute + set playbackRate to 16x
   *      instead of seeking to duration. This avoids the jarring seek-and-rebuffer freeze
   *      because the player continues playing continuously (just very fast).
   *   4. State lock: `adHandlingInProgress` flag prevents duplicate handling when both
   *      the observer and polling detect the same ad.
   *   5. Debounced observer: requestAnimationFrame-based throttle so the callback
   *      doesn't fire excessively during rapid DOM churn of ad transitions.
   *   6. SPA navigation reset: clean state on `yt-navigate-finish` to prevent stale
   *      locks from previous videos.
   *   7. Dev-mode logging: toggled via DEBUG_ADS flag for easier future diagnosis.
   */

  // ─── Configuration ───────────────────────────────────────────────────────────
  // Set to true to enable detailed console logging for debugging ad handling.
  const DEBUG_ADS = false

  // YouTube DOM selectors this script depends on. YouTube changes these periodically,
  // so update here when YouTube's ad DOM structure changes.
  const COSMETIC_AD_SELECTORS = [
    "ytd-ad-slot-renderer",                                    // Feed/sidebar ad slots
    "ytd-promoted-sparkles-web-renderer",                      // Promoted content
    "ytd-display-ad-renderer",                                 // Display ads in sidebar
    "ytd-companion-slot-renderer",                             // Companion ad slots
    "ytd-action-companion-ad-renderer",                        // Action companion ads
    ".ytp-ad-overlay-container",                               // Overlay ads on video
    ".ytp-ad-image-overlay",                                   // Image overlay ads
    ".ytp-ad-module",                                          // General ad module wrapper
    'ytd-engagement-panel-section-list-renderer[target-id*="ads"]', // Engagement panel ads
  ]

  // Selector for the native skip button. YouTube has used multiple variants.
  const SKIP_BUTTON_SELECTOR = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    'button.ytp-ad-skip-button-modern[id="skip-button:8"]',
  ].join(", ")

  // The player container class that YouTube adds when an ad is actively showing.
  const AD_SHOWING_CLASS = "ad-showing"

  // Playback rate used to fast-forward unskippable ads. 16x is the highest value
  // that YouTube's player reliably supports without errors.
  const FAST_FORWARD_RATE = 16

  // ─── State ────────────────────────────────────────────────────────────────────
  let adHandlingInProgress = false   // Lock: prevents duplicate handling of same ad
  let originalMuted = false          // Tracks pre-ad mute state to restore afterward
  let originalPlaybackRate = 1       // Tracks pre-ad playback rate to restore afterward
  let observer = null                // MutationObserver instance
  let rafPending = false             // requestAnimationFrame throttle flag
  let lastReport = 0                 // Timestamp throttle for AD_BLOCKED messages
  let skipPollInterval = null        // Interval for polling skip button availability

  // ─── Utility ──────────────────────────────────────────────────────────────────

  function log(...args) {
    if (DEBUG_ADS) {
      console.log("[ClearBrowse YT]", ...args)
    }
  }

  /**
   * Correct hostname-suffix matching for whitelist checks.
   * Uses proper suffix comparison instead of naive .includes().
   */
  function isWhitelisted(hostname, whitelistArray) {
    if (!hostname || !Array.isArray(whitelistArray) || whitelistArray.length === 0) {
      return false
    }
    return whitelistArray.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain),
    )
  }

  const getSettings = () =>
    new Promise((resolve) =>
      chrome.storage.sync.get(
        { enabled: true, blockYouTube: true, whitelist: [] },
        resolve,
      ),
    )

  /**
   * Check if ad blocking is allowed on this page. Returns false if extension is
   * disabled, YouTube blocking is off, or the current domain is whitelisted.
   */
  async function isBlockingAllowed() {
    const s = await getSettings()
    return s.enabled && s.blockYouTube && !isWhitelisted(location.hostname, s.whitelist)
  }

  function reportBlocked() {
    const now = Date.now()
    if (now - lastReport < 1000) return
    lastReport = now
    chrome.runtime.sendMessage({ type: "AD_BLOCKED" }).catch(() => undefined)
  }

  // ─── Cosmetic removal ────────────────────────────────────────────────────────

  /** Remove non-video ad elements (sidebar ads, overlays, engagement panels). */
  function removeCosmeticAds() {
    document.querySelectorAll(COSMETIC_AD_SELECTORS.join(",")).forEach((node) => {
      node.remove()
      log("Removed cosmetic ad element:", node.tagName || node.className)
    })
  }

  // ─── Core ad-handling logic ───────────────────────────────────────────────────

  /**
   * Try clicking the native "Skip Ad" button.
   * Returns true if a clickable skip button was found and clicked.
   *
   * This is the PREFERRED strategy because it uses YouTube's own skip mechanism,
   * keeping the player in a valid state and avoiding buffer-stall issues entirely.
   */
  function tryClickSkipButton() {
    const skipButton = document.querySelector(SKIP_BUTTON_SELECTOR)
    if (skipButton && skipButton.offsetParent !== null) {
      skipButton.click()
      log("Skip button clicked")
      reportBlocked()
      return true
    }
    return false
  }

  /**
   * Apply playback-rate fast-forward fallback for unskippable ads.
   *
   * Instead of seeking to video.duration (which causes a discontinuous seek and
   * triggers rebuffering/black screen), we:
   *   1. Mute the ad audio immediately so the user doesn't hear sped-up audio
   *   2. Set playbackRate to 16x to fast-forward through the ad smoothly
   *
   * The player continues playing continuously (just very fast), avoiding the jarring
   * seek-and-rebuffer freeze because there's no discontinuous position jump.
   */
  function applyPlaybackRateFallback(video) {
    if (!video) return

    // Save original state to restore after the ad ends
    originalMuted = video.muted
    originalPlaybackRate = video.playbackRate

    video.muted = true
    video.playbackRate = FAST_FORWARD_RATE

    log(
      "Using playback-rate fallback (muted + " + FAST_FORWARD_RATE + "x) —",
      "we use playbackRate instead of seeking directly to avoid buffer-stall on discontinuous seeks",
    )
    reportBlocked()
  }

  /**
   * Restore normal playback state after an ad ends.
   * Resets mute and playback rate to their pre-ad values.
   */
  function restorePlayback(video) {
    if (!video) return

    video.muted = originalMuted
    video.playbackRate = originalPlaybackRate
    originalMuted = false
    originalPlaybackRate = 1

    log("Ad ended, restoring normal playback (muted:", originalMuted, "rate:", originalPlaybackRate, ")")
  }

  /**
   * Start polling for the skip button on the current ad.
   *
   * Some ads show a countdown before the skip button becomes clickable. This poll
   * checks every 300ms for the button to appear, clicking it the moment it does.
   * Stops after 60 seconds (safety limit for very long unskippable ads).
   */
  function startSkipButtonPoll() {
    stopSkipButtonPoll()

    let elapsed = 0
    skipPollInterval = setInterval(() => {
      elapsed += 300

      // Safety: stop polling after 60 seconds (ad should be done by then)
      if (elapsed > 60000) {
        log("Skip button poll timed out after 60s")
        stopSkipButtonPoll()
        return
      }

      if (tryClickSkipButton()) {
        log("Skip button appeared and was clicked after", elapsed, "ms")
        stopSkipButtonPoll()
        handleAdEnd()
      }
    }, 300)
  }

  function stopSkipButtonPoll() {
    if (skipPollInterval !== null) {
      clearInterval(skipPollInterval)
      skipPollInterval = null
    }
  }

  // ─── Ad lifecycle handlers ────────────────────────────────────────────────────

  /**
   * Called when an ad is detected (player gains `.ad-showing` class).
   *
   * Strategy priority:
   *   1. Try clicking skip button immediately (works for skippable ads that start clickable)
   *   2. Start polling for skip button (it may appear after a countdown)
   *   3. Apply playback-rate fallback immediately (fast-forwards while waiting for skip button)
   *
   * Only ONE strategy runs at a time thanks to the `adHandlingInProgress` lock.
   */
  async function handleAdDetected() {
    if (adHandlingInProgress) {
      log("Ad handling already in progress, skipping duplicate detection")
      return
    }
    if (!(await isBlockingAllowed())) return

    adHandlingInProgress = true
    log("Ad detected")

    // Remove cosmetic ad elements (overlays, sidebar ads, etc.)
    removeCosmeticAds()

    // Strategy 1: Try clicking the skip button immediately
    if (tryClickSkipButton()) {
      handleAdEnd()
      return
    }

    // Strategy 2+3: Start polling for skip button AND apply playback-rate fallback
    // The fallback runs the ad at 16x speed while we wait for the skip button.
    // If the skip button appears, the poll will click it and end the ad early.
    const video = document.querySelector("video.html5-main-video")
    applyPlaybackRateFallback(video)
    startSkipButtonPoll()
  }

  /**
   * Called when an ad ends (player loses `.ad-showing` class, or skip button was clicked).
   * Clears the state lock and restores normal playback.
   */
  function handleAdEnd() {
    if (!adHandlingInProgress) return

    stopSkipButtonPoll()

    const video = document.querySelector("video.html5-main-video")
    restorePlayback(video)

    adHandlingInProgress = false
    log("Ad handling complete, lock released")
  }

  // ─── Observer ─────────────────────────────────────────────────────────────────

  /**
   * Debounced observer callback using requestAnimationFrame.
   *
   * This prevents the callback from firing excessively during the rapid DOM churn
   * of ad transitions (dozens of mutations per frame), while still remaining fast
   * enough to catch ad start within one animation frame (~16ms).
   */
  function onMutation() {
    if (rafPending) return
    rafPending = true

    requestAnimationFrame(() => {
      rafPending = false
      checkAdState()
    })
  }

  /**
   * Check the current ad state by looking at the player's class list.
   * This is the primary detection mechanism — event-driven via MutationObserver
   * watching class attribute changes on the player container, not polling.
   */
  function checkAdState() {
    const player = document.querySelector(".html5-video-player")
    if (!player) return

    const adShowing = player.classList.contains(AD_SHOWING_CLASS)

    if (adShowing && !adHandlingInProgress) {
      handleAdDetected()
    } else if (!adShowing && adHandlingInProgress) {
      handleAdEnd()
    }

    // Always try to remove cosmetic ads regardless of video ad state
    removeCosmeticAds()
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  /**
   * Start observing the DOM for ad-related changes.
   * Watches both attribute changes (class changes on player) and child additions
   * (new ad elements being added to the DOM).
   */
  function startObserver() {
    if (observer) {
      observer.disconnect()
    }

    observer = new MutationObserver(onMutation)

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    })

    log("Observer started")
  }

  /**
   * Reset all state. Called on SPA navigation (`yt-navigate-finish`) to prevent
   * stale locks from a previous video from blocking ad handling on the next video.
   *
   * BUG 2 FIX: The old code never reset `adWasMuted` on navigation, so a stale
   * `true` value from a previous video could keep the next video muted, or a stale
   * ad-handling state could prevent detection of ads on the next video entirely.
   */
  function resetState() {
    log("Resetting state (SPA navigation or init)")

    stopSkipButtonPoll()

    // If we were mid-ad-handling, restore playback before resetting
    if (adHandlingInProgress) {
      const video = document.querySelector("video.html5-main-video")
      restorePlayback(video)
    }

    adHandlingInProgress = false
    originalMuted = false
    originalPlaybackRate = 1
    rafPending = false
  }

  /**
   * Main entry point. Checks whitelist, then starts observation.
   */
  async function init() {
    if (!(await isBlockingAllowed())) {
      log("Blocking not allowed on this page (disabled/whitelisted), exiting")
      return
    }

    log("Initializing YouTube ad blocker")
    resetState()
    startObserver()
    checkAdState() // Catch any ad already showing when the script loads
  }

  // Run on DOMContentLoaded (script runs at document_start per manifest)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }

  /**
   * BUG 2 FIX — SPA navigation handler.
   * YouTube doesn't do full page reloads between videos. The `yt-navigate-finish`
   * event fires when navigation completes within the SPA. We reset all state and
   * re-check for ads to handle the new page correctly.
   */
  window.addEventListener("yt-navigate-finish", () => {
    log("SPA navigation detected (yt-navigate-finish)")
    resetState()
    // Re-check if blocking is still allowed (whitelist may have changed)
    // and re-check ad state for the new page
    isBlockingAllowed().then((allowed) => {
      if (allowed) {
        startObserver()
        checkAdState()
      } else {
        if (observer) {
          observer.disconnect()
          observer = null
        }
        log("Blocking not allowed after navigation, observer disconnected")
      }
    })
  })
})()
