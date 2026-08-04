# ClearBrowse — Ad Blocker Chrome Extension

A lightweight, privacy-focused Manifest V3 Chrome extension that blocks ads, trackers, and intrusive popups across the web — including YouTube.

![Chrome Extension](https://img.shields.io/badge/Platform-Chrome-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Features

- **Ad Blocking** — Blocks requests to 30+ major ad networks (Google Ads, DoubleClick, Taboola, Criteo, etc.)
- **Tracker Blocking** — Stops analytics and tracking scripts (Google Analytics, Facebook Pixel, Hotjar, Mixpanel, etc.)
- **YouTube Ad Blocking** — Blocks YouTube-specific ad endpoints and tracking pixels
- **Cosmetic Filtering** — Hides ad containers, banners, and popup overlays via CSS
- **Per-Site Whitelist** — Disable protection on specific sites with a single toggle
- **Blocked Counter** — Tracks ads blocked on the current page and total across all sessions
- **Dark Mode Support** — UI automatically adapts to your system theme
- **Zero Permissions Abuse** — No data collection, no remote servers, everything runs locally

---

## Installation

### From Source (Developer Mode)

1. **Clone the repository**
   ```bash
   git clone https://github.com/sumanpandey21/Ad-Blocker.git
   ```

2. **Open Chrome Extensions page**
   ```
   chrome://extensions/
   ```

3. **Enable Developer Mode** (toggle in the top-right corner)

4. **Click "Load unpacked"** and select the cloned `Ad-Blocker` folder

5. The ClearBrowse icon will appear in your toolbar — you're all set!

---

## Project Structure

```
Ad-Blocker/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker — rule management, whitelist, counters
├── content-scripts/
│   ├── general-blocker.js     # DOM-level ad/popup removal
│   ├── youtube-blocker.js     # YouTube-specific cosmetic filtering
│   └── cosmetic-filters.css   # CSS rules to hide ad containers
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Popup logic — toggle, counters, whitelist
│   └── popup.css              # Popup styling with light/dark theme
├── options/
│   ├── options.html           # Settings page
│   ├── options.js             # Settings logic
│   └── options.css            # Settings styling
├── rules/
│   ├── ad-rules.json          # DeclarativeNetRequest rules for ad domains
│   ├── tracking-rules.json    # DeclarativeNetRequest rules for trackers
│   └── youtube-rules.json     # DeclarativeNetRequest rules for YouTube ads
├── icons/                     # Extension icons (16, 48, 128px)
└── .gitignore
```

---

## 🔧 How It Works

ClearBrowse uses Chrome's **Declarative Net Request (DNR)** API to block ad and tracker requests at the network level — before they even load. This is more efficient and privacy-respecting than older approaches.

| Layer | Mechanism | What It Does |
|---|---|---|
| **Network** | `declarativeNetRequest` static rules | Blocks requests to known ad/tracker domains |
| **Network** | `declarativeNetRequest` dynamic rules | Allows all requests for whitelisted domains |
| **DOM** | Content script (`general-blocker.js`) | Removes ad containers and popup overlays from the page |
| **CSS** | `cosmetic-filters.css` | Hides common ad selectors via stylesheet injection |
| **YouTube** | Content script (`youtube-blocker.js`) | Removes YouTube-specific ad elements |

### Whitelist System

When you whitelist a site:
1. A dynamic DNR `allowAllRequests` rule is registered for that domain (priority 100, overrides all block rules at priority 1)
2. The content script detects the whitelist and skips all DOM manipulation
3. Cosmetic CSS filters are neutralized with an override stylesheet
4. Blocked counters stop incrementing for that site

---

## 🎛️ Usage

1. **Click the ClearBrowse icon** in your Chrome toolbar
2. **Toggle protection** on/off for the current site using the switch
3. **View stats** — see how many ads were blocked on this page and in total
4. **Open Settings** — configure which categories to block (ads, trackers, YouTube, popups)
5. **Report issues** — links directly to this repo's issue tracker

---

## Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m "Add my feature"`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

### Reporting Bugs

Found a site where ads still show? Please [open an issue](https://github.com/sumanpandey21/Ad-Blocker/issues) with:
- The URL of the site
- What ad/tracker slipped through
- A screenshot if possible

---

## Acknowledgements

- Built with Chrome's [Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/) APIs
- Inspired by the open-source ad-blocking community

---

<p align="center">
  Made with by <a href="https://github.com/sumanpandey21">Suman Pandey</a>
</p>
