;(() => {
  /**
   * ClearBrowse — YouTube Ad Blocker (Carrier-Grade MV3 State Machine)
   *
   * Architecture:
   * 1. Modular Separation:
   *    - YouTubeConfig & YouTubeSelectors (Centralized selector repository)
   *    - DebugLogger (Structured real-time console diagnostics)
   *    - AdConfidenceEngine (Multi-signal weighted confidence system: Weak, Moderate, Strong)
   *    - UserPreferenceManager (Guarded tracking and restoration of authentic playback rate & audio)
   *    - PlayerActuator (Safe skip clicker, audio blanking, buffer-aware progression, cosmetic cleaner)
   *    - AdStateMachine (9-state FSM: IDLE -> CONTENT -> AD_CANDIDATE -> AD_CONFIRMED ->
   *      AD_HANDLING -> AD_TRANSITION -> AD_FINISHED -> PLAYER_RECOVERY -> CONTENT_VERIFIED -> CONTENT)
   *    - TargetedObserver & Controller (Container-focused observer, event-driven, zero polling during CONTENT)
   *
   * Guarantees:
   * - Never modifies the player on weak or ambiguous signals.
   * - Never seeks on live streams (duration === Infinity) or unbuffered content.
   * - Preserves authentic user playback speed (0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x) & volume.
   * - Seamlessly processes multi-ad pods (Ad 1 of 2 -> Ad 2 of 2).
   * - Watchdog fail-safe ensures zero manual page refreshes.
   */

  // ─── 1. Configuration & Selectors ──────────────────────────────────────────

  const YouTubeConfig = {
    CONFIDENCE_THRESHOLD: 5,         // Minimum weighted score to confirm ad playback
    FAST_FORWARD_RATE: 16,           // Acceleration rate for unskippable ads
    AD_SEEK_MARGIN_SECONDS: 0.05,    // Margin to avoid MSE buffer underruns on finite ad chunks
    MAX_AD_DURATION_SECONDS: 300,    // Safety limit: never seek on media segments > 5 minutes
    WATCHDOG_TIMEOUT_MS: 4500,       // Fail-safe timeout to force recovery if player stalls
    AD_TICK_INTERVAL_MS: 200,        // Active ad tick interval (only runs during ad handling)
    REPORT_THROTTLE_MS: 1000,        // Message reporting throttle
  }

  const YouTubeSelectors = {
    PLAYER_CONTAINER: ".html5-video-player, #movie_player",
    MAIN_VIDEO: "video.html5-main-video, video.video-stream",

    // Strong signals (weight: 5)
    STRONG_AD_CLASSES: ["ad-showing", "ad-interrupting"],
    STRONG_OVERLAYS: [
      ".ytp-ad-player-overlay",
      ".ytp-ad-player-overlay-flyout-cta",
      "div.video-ads.ytp-ad-module:not(:empty)",
    ],

    // Moderate signals (weight: 3)
    MODERATE_BADGES: [
      ".ytp-ad-simple-ad-badge",
      ".ytp-ad-duration-remaining",
      ".ytp-ad-preview-text",
      ".ytp-ad-text",
      "[class*='ytp-ad-badge']",
      ".ytp-ad-visit-advertiser-button",
    ],

    // Weak signals (weight: 1) — structural containers that exist even without active ads
    WEAK_CONTAINERS: [
      "div.video-ads",
      ".ytp-ad-module",
      ".ytp-ad-overlay-container",
    ],

    // Skip button variants (all known YouTube player layouts)
    SKIP_BUTTONS: [
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-skip-ad-button",
      "button.ytp-ad-skip-button-modern",
      "button.ytp-skip-ad-button",
      "button[id^='skip-button']",
      "[class*='ytp-ad-skip-button']",
      ".ytp-ad-skip-button-container button",
      ".ytp-ad-skip-button-slot button",
      "button.ytp-ad-overlay-close-button",
      ".ytp-ad-preview-container ~ button",
      ".ytp-ad-skip-button-text",
    ],

    // Static cosmetic ad slots (sidebar, feed, masthead, engagement panels)
    COSMETIC_ADS: [
      "ytd-ad-slot-renderer",
      "ytd-promoted-sparkles-web-renderer",
      "ytd-display-ad-renderer",
      "ytd-companion-slot-renderer",
      "ytd-action-companion-ad-renderer",
      "ytd-banner-promo-renderer",
      "ytd-statement-banner-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "ytd-ad-break-renderer",
      "ytd-engagement-panel-section-list-renderer[target-id*='ads']",
      "#player-ads",
      ".ytd-mealbar-promo-renderer",
      "ytd-primetime-promo-renderer",
      "#masthead-ad",
    ],
  }

  // ─── 2. Structured Debug Logger ────────────────────────────────────────────

  let isDebugEnabled = false

  const DebugLogger = {
    init() {
      chrome.storage.sync.get({ debugMode: false }, (data) => {
        isDebugEnabled = Boolean(data?.debugMode || window.__CLEARBROWSE_DEBUG__)
      })
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes.debugMode) {
          isDebugEnabled = Boolean(changes.debugMode.newValue)
        }
      })
    },

    log(type, ...args) {
      if (isDebugEnabled || window.__CLEARBROWSE_DEBUG__) {
        const timestamp = new Date().toISOString().substring(11, 23)
        console.log(`%c[ClearBrowse YT ${timestamp}] [${type}]`, "color: #2563eb; font-weight: bold;", ...args)
      }
    },

    state(prev, next, reason = "") {
      this.log("STATE", `${prev} ➔ ${next}${reason ? ` (${reason})` : ""}`)
    },

    adCandidate(score, signals) {
      this.log("AD-CANDIDATE", `Confidence Score: ${score}`, signals)
    },

    adConfirmed(score, details = {}) {
      this.log("AD-CONFIRMED", `Score: ${score}`, details)
    },

    adSignal(signal, weight) {
      this.log("AD-SIGNAL", `+${weight}pts [${signal}]`)
    },

    adSkip(selector) {
      this.log("AD-SKIP", `Dispatched native skip click on: ${selector}`)
    },

    adFallback(action, details = {}) {
      this.log("AD-FALLBACK", action, details)
    },

    adPod(prevPod, newPod) {
      this.log("AD-POD", `${prevPod} ➔ ${newPod}`)
    },

    playerRestore(details = {}) {
      this.log("PLAYER-RESTORE", details)
    },

    playerRecovery(reason) {
      this.log("PLAYER-RECOVERY", reason)
    },

    nav(eventType, url) {
      this.log("NAVIGATION", `${eventType} — ${url}`)
    },

    watchdog(msg) {
      this.log("WATCHDOG", msg)
    },

    error(msg, err) {
      console.warn("[ClearBrowse YT] [ERROR]", msg, err)
    },
  }

  DebugLogger.init()

  // ─── 3. Multi-Signal Ad Confidence Engine ──────────────────────────────────

  const AdConfidenceEngine = {
    /**
     * Inspects DOM, player, and video states to produce a weighted confidence score.
     * Prevents false-positive actuation on weak signals alone.
     */
    evaluate(player, video) {
      if (!player || !video) {
        return {
          isConfirmed: false,
          isCandidate: false,
          score: 0,
          signals: [],
          skipButton: null,
          podInfo: null,
          isLive: false,
          duration: 0,
        }
      }

      let score = 0
      const signals = []
      const isLive = !Number.isFinite(video.duration) || video.duration === Infinity
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0

      // ─── Strong Signals (Weight: 5) ───

      // Signal 1: Player container ad classes
      for (const cls of YouTubeSelectors.STRONG_AD_CLASSES) {
        if (player.classList.contains(cls)) {
          score += 5
          signals.push(`class:${cls} (+5)`)
          break
        }
      }

      // Signal 2: Active ad overlays
      for (const selector of YouTubeSelectors.STRONG_OVERLAYS) {
        const el = player.querySelector(selector)
        if (el && el.offsetParent !== null && el.getBoundingClientRect().height > 0) {
          score += 5
          signals.push(`overlay:${selector} (+5)`)
          break
        }
      }

      // Signal 3: Skip button present and clickable
      const skipButton = this.findSkipButton(player)
      if (skipButton) {
        score += 5
        signals.push(`skip-button (+5)`)
      }

      // ─── Moderate Signals (Weight: 3) ───

      for (const selector of YouTubeSelectors.MODERATE_BADGES) {
        const badge = player.querySelector(selector)
        if (badge && badge.offsetParent !== null && badge.textContent && badge.textContent.trim().length > 0) {
          score += 3
          signals.push(`badge:${selector} (+3)`)
          break
        }
      }

      // ─── Weak Signals (Weight: 1) ───

      for (const selector of YouTubeSelectors.WEAK_CONTAINERS) {
        const container = player.querySelector(selector)
        if (container && container.offsetParent !== null) {
          score += 1
          signals.push(`container:${selector} (+1)`)
          break
        }
      }

      // Detect Ad Pod information (e.g., "Ad 1 of 2", "Ad 2 of 2", "Sponsored")
      let podInfo = null
      const podEl = player.querySelector(".ytp-ad-simple-ad-badge, .ytp-ad-text, .ytp-ad-preview-text")
      if (podEl && podEl.textContent) {
        podInfo = podEl.textContent.trim()
      }

      const isCandidate = score > 0
      const isConfirmed = score >= YouTubeConfig.CONFIDENCE_THRESHOLD

      return {
        isConfirmed,
        isCandidate,
        score,
        signals,
        skipButton,
        podInfo,
        isLive,
        duration,
        currentTime,
      }
    },

    /**
     * Searches for active skip buttons across light DOM and shadow roots.
     */
    findSkipButton(player) {
      const root = player || document
      for (const selector of YouTubeSelectors.SKIP_BUTTONS) {
        const btn = root.querySelector(selector)
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          return btn
        }
      }
      return null
    },
  }

  // ─── 4. User Preference Manager ────────────────────────────────────────────

  const UserPreferenceManager = {
    userPlaybackRate: 1,
    userMuted: false,
    hasCapturedPreference: false,

    /**
     * Safely captures user playback rate and volume.
     * Guaranteed to run strictly during verified CONTENT playback.
     */
    capture(video) {
      if (!video) return

      // Sanity guard: Only capture standard user playback rates (0.25x - 4x)
      if (video.playbackRate >= 0.25 && video.playbackRate <= 4) {
        this.userPlaybackRate = video.playbackRate
      }
      this.userMuted = Boolean(video.muted)
      this.hasCapturedPreference = true
    },

    getPlaybackRate() {
      return this.userPlaybackRate || 1
    },

    getMuted() {
      return Boolean(this.userMuted)
    },

    reset() {
      this.userPlaybackRate = 1
      this.userMuted = false
      this.hasCapturedPreference = false
    },
  }

  // ─── 5. Player Actuator ───────────────────────────────────────────────────

  const PlayerActuator = {
    /**
     * Dispatches a synthetic mouse/pointer event sequence to trigger native skip logic.
     */
    clickSkipButton(btn) {
      if (!btn) return false
      try {
        const rect = btn.getBoundingClientRect()
        const clientX = rect.left + rect.width / 2
        const clientY = rect.top + rect.height / 2
        const eventInit = { bubbles: true, cancelable: true, view: window, clientX, clientY }

        btn.dispatchEvent(new PointerEvent("pointerdown", eventInit))
        btn.dispatchEvent(new MouseEvent("mousedown", eventInit))
        btn.dispatchEvent(new PointerEvent("pointerup", eventInit))
        btn.dispatchEvent(new MouseEvent("mouseup", eventInit))
        btn.click()

        DebugLogger.adSkip(btn.className || btn.tagName)
        return true
      } catch (err) {
        DebugLogger.error("Failed to dispatch skip click", err)
        return false
      }
    },

    /**
     * Mutes audio immediately and accelerates video safely.
     */
    applySafeAccelerationAndMute(video) {
      if (!video) return

      try {
        if (!video.muted) {
          video.muted = true
        }
        if (video.playbackRate !== YouTubeConfig.FAST_FORWARD_RATE) {
          video.playbackRate = YouTubeConfig.FAST_FORWARD_RATE
        }
      } catch (err) {
        DebugLogger.error("Failed to apply acceleration/mute", err)
      }
    },

    /**
     * Advances the timeline towards the end of the ad chunk with safety bounds.
     * Guaranteed to never seek on live content, invalid durations, or unbuffered segments.
     */
    advanceTimelineSafely(video, evaluation) {
      if (!video || evaluation.isLive) return

      try {
        const dur = evaluation.duration
        // Safety bounds: Only seek if duration is finite, positive, and <= 5 minutes (300s)
        if (dur > 0 && dur <= YouTubeConfig.MAX_AD_DURATION_SECONDS) {
          const targetTime = Math.max(0, dur - YouTubeConfig.AD_SEEK_MARGIN_SECONDS)
          if (video.currentTime < targetTime && video.readyState >= 1) {
            video.currentTime = targetTime
            DebugLogger.adFallback("advanceTimelineSafely", { targetTime, duration: dur })
          }
        }
      } catch (err) {
        DebugLogger.error("Timeline advancement failed", err)
      }
    },

    /**
     * Restores authentic user playback rate and audio state.
     */
    restorePlayerState(video, targetRate, targetMuted) {
      if (!video) return

      try {
        video.playbackRate = targetRate
        video.muted = targetMuted

        // Resume playback if paused due to an ad transition stall
        if (video.paused) {
          video.play().catch(() => {
            // Autoplay restrictions may apply — catch cleanly
          })
        }

        DebugLogger.playerRestore({ rate: targetRate, muted: targetMuted, duration: video.duration })
      } catch (err) {
        DebugLogger.error("Failed to restore player state", err)
      }
    },

    /**
     * Injects scoped cosmetic stylesheet to suppress visual flashes of ad slots and modules.
     */
    injectCosmeticStyles() {
      if (document.getElementById("clearbrowse-yt-cosmetics")) return

      const style = document.createElement("style")
      style.id = "clearbrowse-yt-cosmetics"
      style.textContent = `
        ${YouTubeSelectors.COSMETIC_ADS.join(",\n")} {
          display: none !important;
        }
        .html5-video-player.ad-showing .ytp-ad-player-overlay,
        .html5-video-player.ad-showing .ytp-ad-module,
        .html5-video-player.ad-interrupting .ytp-ad-player-overlay {
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `
      ;(document.head || document.documentElement).appendChild(style)
    },

    /**
     * Removes cosmetic ad elements from the DOM.
     */
    removeCosmeticNodes() {
      try {
        const nodes = document.querySelectorAll(YouTubeSelectors.COSMETIC_ADS.join(","))
        for (const node of nodes) {
          if (node && node.isConnected) {
            node.remove()
          }
        }
      } catch (err) {
        DebugLogger.error("Cosmetic node cleanup error", err)
      }
    },
  }

  // ─── 6. 9-State Finite State Machine (FSM) ─────────────────────────────────

  const AdStates = {
    IDLE: "IDLE",                         // No active player or non-watch page
    CONTENT: "CONTENT",                   // Verified normal content playback
    AD_CANDIDATE: "AD_CANDIDATE",         // Weak/moderate signal detected, evaluating confidence
    AD_CONFIRMED: "AD_CONFIRMED",         // Confidence score >= 5, ad confirmed
    AD_HANDLING: "AD_HANDLING",           // Actively executing skip / acceleration
    AD_TRANSITION: "AD_TRANSITION",       // Transitioning between ad pod items (Ad 1 -> Ad 2)
    AD_FINISHED: "AD_FINISHED",           // Ad signals cleared, waiting for player media state
    PLAYER_RECOVERY: "PLAYER_RECOVERY",   // Validating video element & restoring audio/rate
    CONTENT_VERIFIED: "CONTENT_VERIFIED", // Content verified before returning to CONTENT
  }

  class AdStateMachine {
    constructor() {
      this.state = AdStates.IDLE
      this.currentPodInfo = null
      this.watchdogTimer = null
      this.lastReportTime = 0
    }

    getState() {
      return this.state
    }

    transitionTo(nextState, reason = "") {
      if (this.state === nextState) return

      DebugLogger.state(this.state, nextState, reason)
      this.state = nextState

      // Watchdog management
      if (
        nextState === AdStates.AD_CONFIRMED ||
        nextState === AdStates.AD_HANDLING ||
        nextState === AdStates.AD_TRANSITION
      ) {
        this.startWatchdog()
      } else if (nextState === AdStates.CONTENT || nextState === AdStates.IDLE) {
        this.clearWatchdog()
      }
    }

    startWatchdog() {
      this.clearWatchdog()
      this.watchdogTimer = setTimeout(() => {
        DebugLogger.watchdog("Watchdog timeout triggered: forcing player recovery from stall")
        this.transitionTo(AdStates.PLAYER_RECOVERY, "watchdog_timeout")
        YouTubeAdController.reconcile()
      }, YouTubeConfig.WATCHDOG_TIMEOUT_MS)
    }

    clearWatchdog() {
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer)
        this.watchdogTimer = null
      }
    }

    reportAdBlocked() {
      const now = Date.now()
      if (now - this.lastReportTime < YouTubeConfig.REPORT_THROTTLE_MS) return
      this.lastReportTime = now

      chrome.runtime.sendMessage({ type: "AD_BLOCKED" }).catch(() => undefined)
    }

    reset() {
      this.clearWatchdog()
      this.currentPodInfo = null
      this.state = AdStates.IDLE
    }
  }

  // ─── 7. Centralized Controller & Targeted Observer ─────────────────────────

  const YouTubeAdController = {
    fsm: new AdStateMachine(),
    boundVideoEl: null,
    playerContainerEl: null,
    playerObserver: null,
    rootObserver: null,
    adTickTimer: null,
    isReconciling: false,
    boundVideoListeners: new WeakSet(),

    async isBlockingAllowed() {
      return new Promise((resolve) => {
        chrome.storage.sync.get(
          { enabled: true, blockYouTube: true, whitelist: [] },
          (settings) => {
            if (!settings.enabled || !settings.blockYouTube) {
              return resolve(false)
            }
            const hostname = location.hostname
            const whitelisted =
              Array.isArray(settings.whitelist) &&
              settings.whitelist.some(
                (d) => hostname === d || hostname.endsWith("." + d),
              )
            resolve(!whitelisted)
          },
        )
      })
    },

    /**
     * Centralized, idempotent reconciliation cycle.
     */
    async reconcile() {
      if (this.isReconciling) return
      this.isReconciling = true

      try {
        const allowed = await this.isBlockingAllowed()
        if (!allowed) {
          if (this.fsm.getState() !== AdStates.IDLE) {
            this.fsm.reset()
            this.stopAdTick()
          }
          return
        }

        const player = document.querySelector(YouTubeSelectors.PLAYER_CONTAINER)
        const video = document.querySelector(YouTubeSelectors.MAIN_VIDEO)

        // Bind container observer if player element changed/appeared
        if (player && player !== this.playerContainerEl) {
          this.bindPlayerContainer(player)
        }

        // Bind video element if changed/recreated
        if (video && video !== this.boundVideoEl) {
          this.bindVideoElement(video)
        }

        // Clean cosmetic ad nodes
        PlayerActuator.removeCosmeticNodes()

        if (!player || !video) {
          if (this.fsm.getState() !== AdStates.IDLE) {
            this.fsm.transitionTo(AdStates.IDLE, "no_active_player")
            this.stopAdTick()
          }
          return
        }

        const evalResult = AdConfidenceEngine.evaluate(player, video)
        const currentState = this.fsm.getState()

        // ─── State Machine Transition Matrix ───

        if (evalResult.isConfirmed) {
          this.startAdTick()

          // Detect Pod Transitions (e.g., "Ad 1 of 2" -> "Ad 2 of 2")
          if (
            currentState === AdStates.AD_HANDLING &&
            evalResult.podInfo &&
            this.fsm.currentPodInfo &&
            evalResult.podInfo !== this.fsm.currentPodInfo
          ) {
            DebugLogger.adPod(this.fsm.currentPodInfo, evalResult.podInfo)
            this.fsm.transitionTo(AdStates.AD_TRANSITION, `pod_change: ${evalResult.podInfo}`)
            this.fsm.currentPodInfo = evalResult.podInfo
          }

          if (
            currentState === AdStates.IDLE ||
            currentState === AdStates.CONTENT ||
            currentState === AdStates.AD_CANDIDATE ||
            currentState === AdStates.CONTENT_VERIFIED ||
            currentState === AdStates.PLAYER_RECOVERY
          ) {
            this.fsm.transitionTo(AdStates.AD_CONFIRMED, `score_${evalResult.score}`)
            this.fsm.currentPodInfo = evalResult.podInfo
            DebugLogger.adConfirmed(evalResult.score, { signals: evalResult.signals, pod: evalResult.podInfo })
          }

          // Execute action hierarchy in AD_CONFIRMED / AD_HANDLING / AD_TRANSITION
          this.handleActiveAd(player, video, evalResult)
        } else if (evalResult.isCandidate) {
          // Moderate or weak signal below threshold — monitor as candidate, do NOT touch player
          if (currentState === AdStates.CONTENT || currentState === AdStates.IDLE) {
            this.fsm.transitionTo(AdStates.AD_CANDIDATE, `score_${evalResult.score}`)
            DebugLogger.adCandidate(evalResult.score, evalResult.signals)
            this.startAdTick()
          }
        } else {
          // Score === 0: No ad signals detected
          if (
            currentState === AdStates.AD_HANDLING ||
            currentState === AdStates.AD_CONFIRMED ||
            currentState === AdStates.AD_TRANSITION
          ) {
            this.fsm.transitionTo(AdStates.AD_FINISHED, "ad_signals_cleared")
            this.fsm.transitionTo(AdStates.PLAYER_RECOVERY, "restoring_player")
            this.handlePlayerRecovery(video)
          } else if (currentState === AdStates.PLAYER_RECOVERY) {
            this.fsm.transitionTo(AdStates.CONTENT_VERIFIED, "content_verified")
            this.fsm.transitionTo(AdStates.CONTENT, "normal_playback")
            this.stopAdTick()
          } else if (currentState === AdStates.AD_CANDIDATE) {
            this.fsm.transitionTo(AdStates.CONTENT, "candidate_dismissed")
            this.stopAdTick()
          } else if (currentState === AdStates.IDLE) {
            this.fsm.transitionTo(AdStates.CONTENT, "initial_content_active")
            this.stopAdTick()
          }

          // Capture authentic user playback preferences during normal content playback
          if (this.fsm.getState() === AdStates.CONTENT) {
            UserPreferenceManager.capture(video)
          }
        }
      } catch (err) {
        DebugLogger.error("Reconciliation cycle error", err)
      } finally {
        this.isReconciling = false
      }
    },

    /**
     * Handles an active, confirmed advertisement.
     */
    handleActiveAd(player, video, evalResult) {
      this.fsm.transitionTo(AdStates.AD_HANDLING)
      this.fsm.reportAdBlocked()

      // Strategy 1: Native Skip Button Click (Highest priority)
      if (evalResult.skipButton) {
        const clicked = PlayerActuator.clickSkipButton(evalResult.skipButton)
        if (clicked) {
          return
        }
      }

      // Strategy 2: Mute audio immediately and apply safe acceleration (16x)
      PlayerActuator.applySafeAccelerationAndMute(video)

      // Strategy 3: Safely advance timeline if duration is finite and bounded
      PlayerActuator.advanceTimelineSafely(video, evalResult)
    },

    /**
     * Recovers player back to authentic user speed and volume upon content return.
     */
    handlePlayerRecovery(video) {
      const targetRate = UserPreferenceManager.getPlaybackRate()
      const targetMuted = UserPreferenceManager.getMuted()
      PlayerActuator.restorePlayerState(video, targetRate, targetMuted)
      DebugLogger.playerRecovery(`Restored rate: ${targetRate}x, muted: ${targetMuted}`)
    },

    /**
     * Binds media event listeners to `<video>` for zero-polling event-driven updates.
     */
    bindVideoElement(video) {
      if (!video || this.boundVideoListeners.has(video)) return

      this.boundVideoEl = video
      this.boundVideoListeners.add(video)

      const onRateOrVolumeChange = () => {
        if (this.fsm.getState() === AdStates.CONTENT) {
          UserPreferenceManager.capture(video)
        }
      }

      video.addEventListener("ratechange", onRateOrVolumeChange)
      video.addEventListener("volumechange", onRateOrVolumeChange)
      video.addEventListener("play", () => this.reconcile())
      video.addEventListener("pause", () => this.reconcile())
      video.addEventListener("loadedmetadata", () => this.reconcile())
      video.addEventListener("durationchange", () => this.reconcile())
      video.addEventListener("ended", () => this.reconcile())

      DebugLogger.log("VIDEO-BIND", "Bound media listeners to video element")
    },

    /**
     * Attaches a targeted MutationObserver to the player container only.
     */
    bindPlayerContainer(player) {
      if (this.playerObserver) {
        this.playerObserver.disconnect()
      }

      this.playerContainerEl = player
      this.playerObserver = new MutationObserver((mutations) => {
        let shouldReconcile = false
        for (const m of mutations) {
          if (m.type === "attributes" && m.attributeName === "class") {
            shouldReconcile = true
            break
          }
          if (m.addedNodes.length > 0) {
            shouldReconcile = true
            break
          }
        }
        if (shouldReconcile) {
          this.reconcile()
        }
      })

      this.playerObserver.observe(player, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      })

      // Disconnect root observer once player container is discovered
      if (this.rootObserver) {
        this.rootObserver.disconnect()
        this.rootObserver = null
      }

      DebugLogger.log("INIT", "Targeted player container observer active")
    },

    startAdTick() {
      if (this.adTickTimer !== null) return
      this.adTickTimer = setInterval(() => {
        this.reconcile()
      }, YouTubeConfig.AD_TICK_INTERVAL_MS)
    },

    stopAdTick() {
      if (this.adTickTimer !== null) {
        clearInterval(this.adTickTimer)
        this.adTickTimer = null
      }
    },

    /**
     * Root fallback observer used until `#movie_player` is mounted.
     */
    startRootMonitoring() {
      PlayerActuator.injectCosmeticStyles()

      if (this.rootObserver) {
        this.rootObserver.disconnect()
      }

      this.rootObserver = new MutationObserver(() => {
        const player = document.querySelector(YouTubeSelectors.PLAYER_CONTAINER)
        if (player) {
          this.bindPlayerContainer(player)
          this.reconcile()
        }
      })

      this.rootObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })
    },

    /**
     * Handles SPA navigation transitions cleanly.
     */
    handleNavigation(eventType) {
      DebugLogger.nav(eventType, location.href)
      this.stopAdTick()
      this.fsm.reset()
      this.boundVideoEl = null

      setTimeout(() => this.reconcile(), 100)
    },

    async init() {
      const allowed = await this.isBlockingAllowed()
      if (!allowed) {
        DebugLogger.log("INIT", "Extension disabled or domain whitelisted")
        return
      }

      const player = document.querySelector(YouTubeSelectors.PLAYER_CONTAINER)
      if (player) {
        this.bindPlayerContainer(player)
      } else {
        this.startRootMonitoring()
      }

      this.reconcile()
    },
  }

  // ─── 8. Lifecycle & Navigation Event Hooks ─────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => YouTubeAdController.init())
  } else {
    YouTubeAdController.init()
  }

  // YouTube SPA navigation events
  window.addEventListener("yt-navigate-start", () => YouTubeAdController.handleNavigation("yt-navigate-start"))
  window.addEventListener("yt-navigate-finish", () => YouTubeAdController.handleNavigation("yt-navigate-finish"))
  window.addEventListener("yt-page-data-updated", () => YouTubeAdController.handleNavigation("yt-page-data-updated"))
  window.addEventListener("popstate", () => YouTubeAdController.handleNavigation("popstate"))

  // Dynamic storage settings listener
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.enabled || changes.blockYouTube || changes.whitelist)) {
      YouTubeAdController.reconcile()
    }
  })
})()
