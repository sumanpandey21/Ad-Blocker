const DEFAULT_SETTINGS = {
  enabled: true,
  blockGeneral: true,
  blockYouTube: true,
  blockPopups: true,
  blockTracking: true,
  whitelist: [],
}

let currentTab = null
let currentDomain = "this page"

/**
 * Proper hostname-suffix matching for whitelist checks.
 * Exact match: "example.com" matches "example.com"
 * Subdomain match: "www.example.com" matches whitelist entry "example.com"
 */
function isWhitelisted(hostname, whitelistArray) {
  if (!hostname || !Array.isArray(whitelistArray) || whitelistArray.length === 0) {
    return false
  }
  return whitelistArray.some(
    (domain) => hostname === domain || hostname.endsWith("." + domain),
  )
}

async function load() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  ;[currentTab] = tabs

  if (!currentTab?.url) {
    return
  }

  try {
    currentDomain = new URL(currentTab.url).hostname
  } catch {
    currentDomain = "this page"
  }

  const siteNameEl = document.querySelector("#site-name")
  if (siteNameEl) {
    siteNameEl.textContent = currentDomain
  }

  const [settings, localState] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get({ totalBlocked: 0, tabCounts: {}, whitelistError: null }),
  ])

  const siteWhitelisted = isWhitelisted(currentDomain, settings.whitelist)
  const protectionActive = settings.enabled && !siteWhitelisted

  const siteToggleEl = document.querySelector("#site-toggle")
  if (siteToggleEl) {
    siteToggleEl.checked = protectionActive
  }

  const pageCountEl = document.querySelector("#page-count")
  if (pageCountEl) {
    // Whitelisted sites should always show 0 — blocking is not active there
    pageCountEl.textContent = siteWhitelisted
      ? 0
      : localState.tabCounts[currentTab?.id] || 0
  }

  const totalCountEl = document.querySelector("#total-count")
  if (totalCountEl) {
    totalCountEl.textContent = localState.totalBlocked || 0
  }

  // Show/hide whitelist status banner
  const statusEl = document.querySelector("#whitelist-status")
  if (statusEl) {
    statusEl.style.display = siteWhitelisted ? "flex" : "none"
  }

  // Show/hide whitelist error banner
  const errorEl = document.querySelector("#whitelist-error")
  const errorTextEl = document.querySelector("#whitelist-error-text")
  if (errorEl) {
    if (localState.whitelistError) {
      errorEl.style.display = "flex"
      if (errorTextEl) {
        errorTextEl.textContent = localState.whitelistError
      }
    } else {
      errorEl.style.display = "none"
    }
  }

  // Header status indicator dot
  const headerDotEl = document.querySelector("#header-dot")
  if (headerDotEl) {
    if (protectionActive) {
      headerDotEl.classList.remove("disabled")
      headerDotEl.title = "Protection Active"
    } else {
      headerDotEl.classList.add("disabled")
      headerDotEl.title = siteWhitelisted ? "Disabled on this site" : "Protection Disabled"
    }
  }
}

async function updateSiteProtection(enabled) {
  const { whitelist = [] } = await chrome.storage.sync.get({ whitelist: [] })
  const nextList = new Set(whitelist)

  if (enabled) {
    for (const entry of whitelist) {
      if (currentDomain === entry || currentDomain.endsWith("." + entry)) {
        nextList.delete(entry)
      }
    }
  } else {
    nextList.add(currentDomain)
  }

  await chrome.storage.sync.set({ whitelist: [...nextList] })

  if (currentTab?.id) {
    chrome.tabs.reload(currentTab.id)
  }

  await load()
}

document.querySelector("#site-toggle")?.addEventListener("change", (event) => {
  updateSiteProtection(event.target.checked)
})

document.querySelector("#options-button")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage()
})

document.querySelector("#report-link")?.addEventListener("click", (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: "https://github.com/sumanpandey21/Ad-Blocker/issues" })
})

load()
