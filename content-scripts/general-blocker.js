;(() => {
  /**
   * BUG 1 FIX — Whitelist gate in general-blocker.js
   *
   * WHAT WAS WRONG: The old code checked the whitelist INSIDE the async `removeAds()`
   * function, but the MutationObserver was created and started observing BEFORE that
   * check ever ran. This meant:
   *   1. On whitelisted sites, the observer still fired on every DOM mutation,
   *      calling `removeAds()` which then did an async storage read each time
   *   2. The whitelist check used `.includes(location.hostname)` — naive exact-match
   *      that missed subdomains (www.example.com vs example.com)
   *   3. cosmetic-filters.css (injected via manifest) always applied, ignoring whitelist
   *
   * THE FIX:
   *   - Check whitelist at script start, BEFORE creating any observer or DOM work
   *   - Use proper hostname-suffix matching via isWhitelisted()
   *   - On whitelisted sites, inject an override <style> that neutralizes cosmetic-filters.css
   *   - Exit immediately if whitelisted — no observer, no DOM manipulation
   */

  // Keep selectors in one place so they can be adjusted whenever a site changes its layout.
  const AD_SELECTORS = [
    ".ad-container",
    ".ad-banner",
    ".banner-ad",
    ".advertisement",
    ".advertisement-container",
    ".adsbygoogle",
    ".google-auto-placed",
    "#ad-slot",
    "#ad-container",
    "#advertisement",
    "[data-ad-slot]",
    "[data-ad-client]",
    "[data-ad-container]",
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
  ]

  const POPUP_SELECTORS = [
    ".popup-ad",
    ".ad-popup",
    ".advert-modal",
    "[data-ad-popup]",
    ".modal-ad",
  ]

  /**
   * These are the same selectors used in cosmetic-filters.css. When a site is
   * whitelisted, we inject an override stylesheet that resets `display` on these
   * selectors, effectively neutralizing the static CSS that the manifest injects
   * unconditionally.
   */
  const COSMETIC_OVERRIDE_SELECTORS = [
    ".ad-container",
    ".ad-banner",
    ".banner-ad",
    ".advertisement",
    ".advertisement-container",
    ".adsbygoogle",
    ".google-auto-placed",
    "#ad-slot",
    "#ad-container",
    "#advertisement",
    "[data-ad-slot]",
    "[data-ad-client]",
    "[data-ad-container]",
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    ".modal-ad",
    ".ad-popup",
    ".popup-ad",
  ]

  /**
   * Correct hostname-suffix matching for whitelist checks.
   * - Exact match: "example.com" matches "example.com" ✓
   * - Subdomain match: "www.example.com" matches whitelist entry "example.com" ✓
   * - No false positives: "notexample.com" does NOT match "example.com" ✗
   *
   * Uses proper suffix comparison (hostname === domain || hostname.endsWith('.' + domain))
   * instead of the old naive .includes() which would miss subdomains entirely.
   */
  function isWhitelisted(hostname, whitelistArray) {
    if (!hostname || !Array.isArray(whitelistArray) || whitelistArray.length === 0) {
      return false
    }
    return whitelistArray.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain),
    )
  }

  /**
   * Inject an override stylesheet that neutralizes cosmetic-filters.css.
   * Since cosmetic-filters.css is statically declared in manifest.json and we can't
   * conditionally prevent its injection from a content script, we override all its
   * selectors with `display: revert !important` to restore the browser's default
   * rendering for whitelisted sites.
   */
  function injectCosmeticOverride() {
    const style = document.createElement("style")
    style.id = "clearbrowse-whitelist-override"
    style.textContent =
      COSMETIC_OVERRIDE_SELECTORS.join(",\n") +
      " { display: revert !important; }"
    ;(document.head || document.documentElement).appendChild(style)
  }

  const getSettings = () =>
    new Promise((resolve) =>
      chrome.storage.sync.get(
        { enabled: true, blockGeneral: true, blockPopups: true, whitelist: [] },
        resolve,
      ),
    )

  const report = () => {
    chrome.runtime.sendMessage({ type: "AD_BLOCKED" }).catch(() => undefined)
  }

  function removeAds(root, selectors) {
    const nodes = root.querySelectorAll?.(selectors.join(","))
    if (!nodes?.length) {
      return
    }

    nodes.forEach((node) => {
      if (node?.isConnected) {
        node.remove()
        report()
      }
    })
  }

  /**
   * Main entry point. We check the whitelist FIRST, synchronously gating all
   * subsequent work. The async storage read completes before any observer or
   * DOM manipulation begins.
   */
  async function init() {
    const settings = await getSettings()

    // Gate 1: Extension disabled globally — do nothing
    if (!settings.enabled) {
      return
    }

    // Gate 2: Site is whitelisted — neutralize cosmetic CSS and exit immediately
    if (isWhitelisted(location.hostname, settings.whitelist)) {
      injectCosmeticOverride()
      return // No observer, no DOM manipulation, no ad removal
    }

    // Build selector list based on active feature toggles
    const selectors = [
      ...(settings.blockGeneral ? AD_SELECTORS : []),
      ...(settings.blockPopups ? POPUP_SELECTORS : []),
    ]

    if (!selectors.length) {
      return
    }

    // Initial pass on existing DOM
    removeAds(document, selectors)

    // Observe future DOM additions
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            removeAds(node, selectors)
          }
        }
      }
    })

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  /**
   * BUG 1 FIX — Timing: We run at document_start (per manifest), so DOMContentLoaded
   * is the right moment to begin DOM work. The whitelist check inside init() ensures
   * we wait for the async storage read before doing anything.
   */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }
})()
