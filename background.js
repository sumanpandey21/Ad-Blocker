const DEFAULT_SETTINGS = {
  enabled: true,
  blockGeneral: true,
  blockYouTube: true,
  blockPopups: true,
  blockTracking: true,
  whitelist: [],
}

const RULE_SETS = ["ad_rules", "tracking_rules", "youtube_rules"]
const WHITELIST_RULE_ID_START = 5000

/**
 * Correct hostname-suffix matching for whitelist checks.
 * - Exact match: "example.com" in list matches page "example.com"
 * - Subdomain match: "example.com" in list matches page "www.example.com"
 * - No false positives: "example.com" in list does NOT match "notexample.com"
 *
 * BUG 1 FIX: The old code used `whitelist.includes(hostname)` which is a naive
 * array-element exact match — it would miss subdomains entirely (e.g., whitelisting
 * "example.com" did NOT whitelist "www.example.com") and could not do suffix matching.
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
  new Promise((resolve) => chrome.storage.sync.get(DEFAULT_SETTINGS, resolve))

async function updateRulesets(settings) {
  if (!settings) {
    settings = await getSettings()
  }

  const enableRulesetIds = settings.enabled
    ? [
        ...(settings.blockGeneral ? ["ad_rules"] : []),
        ...(settings.blockTracking ? ["tracking_rules"] : []),
        ...(settings.blockYouTube ? ["youtube_rules"] : []),
      ]
    : []

  const disableRulesetIds = RULE_SETS.filter(
    (id) => !enableRulesetIds.includes(id),
  )

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    })
  } catch (error) {
    console.warn("ClearBrowse could not update network rules:", error)
  }

  await updateWhitelistRules(settings)
}

/**
 * BUG 1 FIX — DNR whitelist allow-rules.
 *
 * WHAT WAS WRONG (original bug): allow-rules had priority: 1, same as block rules.
 * WHAT WAS STILL WRONG (remaining bug): the code used resourceTypes with 10 types
 * (stylesheet, script, image, etc.), but Chrome requires allowAllRequests rules to
 * ONLY specify ["main_frame", "sub_frame"]. Any other type causes the entire
 * updateDynamicRules() call to throw, so whitelist rules never registered at all.
 *
 * THE FIX:
 *   - resourceTypes: ["main_frame", "sub_frame"] only. The "allowAllRequests" action
 *     automatically cascades the allow to ALL sub-requests within the matched frame,
 *     so you only need to match the frame navigation itself.
 *   - priority: 100 to override block rules (priority: 1)
 *   - Error flag in chrome.storage.local so the popup can surface failures visibly
 *   - Verification logging via getDynamicRules() after every update
 */
async function updateWhitelistRules(settings) {
  if (!settings) {
    settings = await getSettings()
  }

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules()
  const removableIds = existingRules
    .filter((rule) => rule.id >= WHITELIST_RULE_ID_START)
    .map((rule) => rule.id)

  const addRules = settings.whitelist.map((domain, index) => ({
    id: WHITELIST_RULE_ID_START + index,
    priority: 100,
    action: { type: "allowAllRequests" },
    condition: {
      requestDomains: [domain],
      resourceTypes: ["main_frame", "sub_frame"],
    },
  }))

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removableIds,
      addRules,
    })

    // Clear any previous error state
    await chrome.storage.local.set({ whitelistError: null })

    // Verification: log active whitelist rules so devs can confirm registration
    const activeRules = await chrome.declarativeNetRequest.getDynamicRules()
    const whitelistRules = activeRules.filter(
      (r) => r.id >= WHITELIST_RULE_ID_START,
    )
    if (whitelistRules.length > 0) {
      console.log(
        "✅ Whitelist rules active:",
        JSON.stringify(whitelistRules, null, 2),
      )
    } else {
      console.log("ℹ️ No whitelist rules active (whitelist is empty).")
    }
  } catch (error) {
    const errorMsg = `Whitelist update failed: ${error.message || error}`
    console.error("❌ ClearBrowse could not update whitelist rules:", error)

    // Persist error state so the popup UI can surface it
    await chrome.storage.local.set({ whitelistError: errorMsg })
  }
}

async function incrementCount(tabId, amount = 1) {
  if (typeof tabId !== "number" || tabId < 0) {
    return
  }

  const data = await chrome.storage.local.get({
    totalBlocked: 0,
    tabCounts: {},
  })
  data.tabCounts[tabId] = (data.tabCounts[tabId] || 0) + amount

  await chrome.storage.local.set({
    totalBlocked: data.totalBlocked + amount,
    tabCounts: data.tabCounts,
  })
}

async function resetStats() {
  await chrome.storage.local.set({ totalBlocked: 0, tabCounts: {} })
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS)
  await chrome.storage.sync.set(current)

  if (details.reason === "install") {
    await resetStats()
  }

  await updateRulesets(current)
})

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings()
  await updateRulesets(settings)
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") {
    return
  }

  const needsRuleRefresh = [
    "enabled",
    "blockGeneral",
    "blockTracking",
    "blockYouTube",
  ].some((key) => changes[key])

  if (needsRuleRefresh) {
    getSettings().then(updateRulesets)
  }

  if (changes.whitelist) {
    getSettings().then(updateRulesets)
  }
})

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabCounts = {} } = await chrome.storage.local.get({ tabCounts: {} })
  delete tabCounts[tabId]
  await chrome.storage.local.set({ tabCounts })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AD_BLOCKED") {
    // Only count blocks for non-whitelisted sites
    const tabUrl = sender.tab?.url
    if (tabUrl) {
      getSettings().then((settings) => {
        try {
          const hostname = new URL(tabUrl).hostname
          if (!isWhitelisted(hostname, settings.whitelist)) {
            incrementCount(sender.tab?.id, message.amount || 1)
          }
        } catch {
          // Invalid URL — increment anyway as a safe fallback
          incrementCount(sender.tab?.id, message.amount || 1)
        }
      })
    }
  }

  if (message.type === "GET_SITE_STATE") {
    getSettings().then((settings) => {
      /**
       * BUG 1 FIX: The old code used `settings.whitelist.includes(message.domain)`
       * which is a naive exact-match check. This meant "www.example.com" would NOT
       * match a whitelist entry of "example.com". Now uses proper suffix matching.
       */
      const siteWhitelisted = isWhitelisted(message.domain, settings.whitelist)
      const isEnabled = settings.enabled && !siteWhitelisted
      sendResponse({ enabled: isEnabled, whitelisted: siteWhitelisted })
    })
    return true
  }

  if (message.type === "RESET_STATS") {
    resetStats()
  }

  return false
})

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((details) => {
  // Only count blocks for non-whitelisted sites
  const tabId = details.request.tabId
  if (typeof tabId !== "number" || tabId < 0) return

  chrome.tabs.get(tabId).then((tab) => {
    if (!tab?.url) return
    getSettings().then((settings) => {
      try {
        const hostname = new URL(tab.url).hostname
        if (!isWhitelisted(hostname, settings.whitelist)) {
          incrementCount(tabId)
        }
      } catch {
        incrementCount(tabId)
      }
    })
  }).catch(() => {
    // Tab may have been removed — ignore
  })
})
