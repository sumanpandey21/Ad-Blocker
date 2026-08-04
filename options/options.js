const DEFAULT_SETTINGS = {
  enabled: true,
  blockGeneral: true,
  blockYouTube: true,
  blockPopups: true,
  blockTracking: true,
  whitelist: [],
}

const SETTINGS_FIELDS = [
  "enabled",
  "blockGeneral",
  "blockYouTube",
  "blockPopups",
  "blockTracking",
]

const toast = document.querySelector("#toast")
const toastMsg = document.querySelector("#toast-message")

const notify = (message) => {
  if (toastMsg) {
    toastMsg.textContent = message
  }
  toast.classList.add("show")
  window.setTimeout(() => toast.classList.remove("show"), 2000)
}

/** Tab Navigation Switching Handler */
function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn")
  const panels = document.querySelectorAll(".tab-panel")

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.getAttribute("data-tab")

      tabs.forEach((t) => t.classList.remove("active"))
      panels.forEach((p) => p.classList.remove("active"))

      tab.classList.add("active")
      const targetPanel = document.querySelector(`#panel-${targetTab}`)
      if (targetPanel) {
        targetPanel.classList.add("active")
      }
    })
  })
}

/** Render Whitelist Items or Empty State */
function renderWhitelist(list) {
  const container = document.querySelector("#whitelist")
  if (!container) return

  container.replaceChildren()

  if (!list || list.length === 0) {
    const emptyState = document.createElement("div")
    emptyState.className = "empty-state"
    emptyState.innerHTML = `
      <div class="empty-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </div>
      <h4>No sites whitelisted yet</h4>
      <p>Add a domain above to allow ads and tracking scripts on specific trusted sites.</p>
    `
    container.append(emptyState)
    return
  }

  list.forEach((domain) => {
    const row = document.createElement("li")
    row.className = "whitelist-item"

    const domainInfo = document.createElement("div")
    domainInfo.className = "whitelist-domain-info"
    domainInfo.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      <span>${domain}</span>
    `

    const button = document.createElement("button")
    button.type = "button"
    button.className = "btn-remove"
    button.textContent = "Remove"
    button.addEventListener("click", async () => {
      const { whitelist = [] } = await chrome.storage.sync.get({ whitelist: [] })
      const nextList = whitelist.filter((item) => item !== domain)
      await chrome.storage.sync.set({ whitelist: nextList })
      await load()
      notify(`Removed ${domain} from whitelist`)
    })

    row.append(domainInfo, button)
    container.append(row)
  })
}

async function load() {
  const [settings, localState] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get({ totalBlocked: 0, tabCounts: {} }),
  ])

  SETTINGS_FIELDS.forEach((field) => {
    const el = document.querySelector(`#${field}`)
    if (el) {
      el.checked = settings[field]
    }
  })

  renderWhitelist(settings.whitelist || [])

  const statsEl = document.querySelector("#stats-summary")
  if (statsEl) {
    statsEl.textContent = `Total blocked: ${localState.totalBlocked || 0}`
  }
}

SETTINGS_FIELDS.forEach((field) => {
  document.querySelector(`#${field}`)?.addEventListener("change", async (event) => {
    await chrome.storage.sync.set({ [field]: event.target.checked })
    notify("Setting saved")
  })
})

document.querySelector("#whitelist-form")?.addEventListener("submit", async (event) => {
  event.preventDefault()
  const input = document.querySelector("#domain")
  const value = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")

  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(value)) {
    notify("Please enter a valid domain (e.g. example.com)")
    return
  }

  const { whitelist = [] } = await chrome.storage.sync.get({ whitelist: [] })
  await chrome.storage.sync.set({ whitelist: [...new Set([...whitelist, value])] })
  input.value = ""
  await load()
  notify(`Added ${value} to whitelist`)
})

document.querySelector("#reset-stats")?.addEventListener("click", async () => {
  await chrome.storage.local.set({ totalBlocked: 0, tabCounts: {} })
  await load()
  notify("Statistics reset to zero")
})

setupTabs()
load()
