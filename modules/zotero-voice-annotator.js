/**
 * Zotero Voice Annotator for Zotero
 * Transcribes audio files and creates PDF highlight annotations from spoken quotes.
 */

const VoiceAnnotator = {
  id: "zotero-voice-annotator@alexanderjfink.github.io",
  rootURI: null,
  menuItems: [],

  // Live voice annotation state
  live: {
    active: false,           // live mode engaged
    capturing: false,        // mic stream process running
    reader: null,            // Zotero reader instance
    pdfItem: null,
    pdfPath: null,
    processPromise: null,
    streamOutPath: null,
    stopFilePath: null,
    words: [],               // accumulated streamed words
    pendingTriggers: [],     // detected but not yet resolved triggers
    detectedStarts: new Set(), // word indices already detected as triggers
    scannedWords: 0,
    queue: null,             // serializes annotation work
    pollTimer: null,
    partialLine: "",
    lastRead: 0,
    streamDone: false,
    toolbarButtons: [],      // [{ reader, button }]
    overlayDocs: []          // iframe documents that received an overlay
  },

  // Zotero's standard annotation highlight colors
  colors: {
    yellow: "#ffd400",
    red: "#ff6666",
    green: "#5fb236",
    blue: "#2ea8e5",
    purple: "#a28ae5",
    orange: "#f19837"
  },

  defaultTriggers: [
    { phrase: "Highlight", color: "#ffd400" },
    { phrase: "Main Theory", color: "#2ea8e5" },
    { phrase: "Key Point", color: "#ff6666" },
    { phrase: "Definition", color: "#5fb236" }
  ],

  getTriggers() {
    try {
      const raw = Zotero.Prefs.get("extensions.zotero-voice-annotator.triggers", true);
      if (!raw) {
        this.log("debug", "No triggers pref set; using defaults");
        return this.defaultTriggers;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.log("debug", "Loaded triggers:", JSON.stringify(parsed));
        return parsed;
      }
      this.log("debug", "Triggers pref empty or invalid; using defaults");
      return this.defaultTriggers;
    } catch (e) {
      this.log("error", "Failed to parse triggers preference, using defaults:", e);
      return this.defaultTriggers;
    }
  },

  getSilenceTimeout() {
    try {
      const val = Zotero.Prefs.get("extensions.zotero-voice-annotator.silenceTimeout", true);
      const num = Number(val);
      return Number.isFinite(num) && num > 0 ? num : 5;
    } catch (e) {
      return 5;
    }
  },

  formatLogArg(a) {
    if (a && (a.message || a.stack)) {
      const parts = [];
      if (a.message) parts.push(a.message);
      if (a.stack) parts.push(a.stack);
      return parts.length > 0 ? parts.join("\n") : String(a);
    }
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  },

  log(level, ...args) {
    const logLevel = Zotero.Prefs.get("extensions.zotero-voice-annotator.logLevel", true) || "info";
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] >= levels[logLevel]) {
      Zotero.debug(`[ZoteroVoiceAnnotator] ${level.toUpperCase()}: ${args.map(a => this.formatLogArg(a)).join(" ")}`);
    }
  },

  async init({ id, version, rootURI }) {
    this.rootURI = rootURI;
    this.log("info", "Initializing Zotero Voice Annotator plugin");

    // Migrate preferences saved under the old extensions.marginalvoice prefix
    await this.migrateLegacyPrefs();

    // Extract bundled helper script to a temp file so Python can execute it
    await this.extractHelperScript();

    // Register preference pane
    if (Zotero.PreferencePanes) {
      try {
        Zotero.PreferencePanes.register({
          pluginID: this.id,
          label: "Zotero Voice Annotator",
          src: this.rootURI + "chrome/content/preferences.xhtml",
          scripts: [this.rootURI + "chrome/content/preferences.js"],
          image: this.rootURI + "skin/icon-48.png"
        });
        this.log("info", "Preference pane registered");
      } catch (e) {
        this.log("error", "Failed to register preference pane:", e);
      }
    } else {
      this.log("warn", "Zotero.PreferencePanes not available");
    }

    // PDF reader integration (live voice annotation)
    this.live.queue = Promise.resolve();
    this.registerReaderIntegration();
  },

  // One-time migration of preferences saved under the old
  // "extensions.marginalvoice." prefix when the plugin was renamed.
  legacyDefault(key) {
    const defaults = {
      transcriptionMode: "python",
      pythonPath: "",
      helperScriptPath: "",
      customCommandPath: "",
      customCommandArgs: "",
      whisperModel: "base",
      fuzzyThreshold: "0.6",
      silenceTimeout: 5,
      skipDuplicates: true,
      logLevel: "info",
      liveMode: "toggle",
      liveShortcut: "CmdOrCtrl+Shift+V",
      liveShowOverlay: true,
      liveFlushInterval: 2,
      liveOverlayPos: "",
      triggers: JSON.stringify(this.defaultTriggers)
    };
    return defaults[key];
  },

  async migrateLegacyPrefs() {
    const NEW = "extensions.zotero-voice-annotator.";
    const OLD = "extensions.marginalvoice.";
    const flag = NEW + "legacyMigrated";
    try {
      if (Zotero.Prefs.get(flag, true)) return;
    } catch (e) {
      return;
    }
    const keys = [
      "transcriptionMode", "pythonPath", "helperScriptPath", "customCommandPath",
      "customCommandArgs", "whisperModel", "fuzzyThreshold", "silenceTimeout",
      "skipDuplicates", "logLevel", "liveMode", "liveShortcut", "liveShowOverlay",
      "liveFlushInterval", "liveOverlayPos", "triggers"
    ];
    let migrated = 0;
    for (const key of keys) {
      let oldVal;
      try {
        oldVal = Zotero.Prefs.get(OLD + key, true);
      } catch (e) {
        continue;
      }
      if (oldVal === undefined || oldVal === null || oldVal === "") continue;
      let newVal;
      try {
        newVal = Zotero.Prefs.get(NEW + key, true);
      } catch (e) {
        newVal = undefined;
      }
      // Only copy if the new pref is still at its default (user hasn't
      // customized it yet).
      if (newVal === this.legacyDefault(key)) {
        try {
          Zotero.Prefs.set(NEW + key, oldVal, true);
          migrated++;
        } catch (e) {
          this.log("debug", "migrateLegacyPrefs set failed for", key, e.message);
        }
      }
    }
    try {
      Zotero.Prefs.set(flag, true, true);
    } catch (e) {}
    if (migrated > 0) {
      this.log("info", `Migrated ${migrated} preference(s) from extensions.marginalvoice`);
    }
  },

  async extractHelperScript() {
    try {
      const helperURI = this.rootURI + "scripts/zaa-helper.py";
      this.log("debug", "Extracting helper script from", helperURI);
      const content = await this.readURI(helperURI);

      const tmpDir = Zotero.getTempDirectory();
      const tmpFile = tmpDir.clone();
      tmpFile.append("zaa-helper.py");
      if (tmpFile.exists()) {
        tmpFile.remove(false);
      }
      await Zotero.File.putContentsAsync(tmpFile, content);
      this.helperScriptTempPath = tmpFile.path;
      this.log("info", "Helper script extracted to", this.helperScriptTempPath);
    } catch (e) {
      this.log("error", "Failed to extract helper script:", e);
      throw e;
    }
  },

  async readURI(uri) {
    // Try modern Fetch API first
    if (typeof fetch !== "undefined") {
      try {
        const response = await fetch(uri);
        if (response.ok) return await response.text();
      } catch (e) {
        this.log("debug", "fetch failed, falling back to NetUtil:", e.message);
      }
    }

    // Fallback to NetUtil for resource:// / jar:// URIs
    const { NetUtil } = ChromeUtils.import("resource://gre/modules/NetUtil.jsm");
    return new Promise((resolve, reject) => {
      NetUtil.asyncFetch(
        {
          uri: Services.io.newURI(uri),
          loadUsingSystemPrincipal: true
        },
        (inputStream, status) => {
          if (Components.isSuccessCode(status)) {
            const data = NetUtil.readInputStreamToString(inputStream, inputStream.available());
            resolve(data);
          } else {
            reject(new Error(`Failed to read URI ${uri}: ${status}`));
          }
        }
      );
    });
  },

  shutdown() {
    this.log("info", "Shutting down Zotero Voice Annotator plugin");
    this.unregisterMenus();
    // Stop any active live capture and remove reader UI
    if (this.live.active || this.live.capturing) {
      this.stopCapture(true).catch(e => this.log("warn", "Live shutdown:", e));
    }
    for (const doc of this.live.overlayDocs) {
      try {
        const el = doc.getElementById("zva-overlay");
        if (el && el.parentNode) el.parentNode.removeChild(el);
      } catch (e) {}
    }
    this.live.overlayDocs = [];
    this.live.toolbarButtons = [];
  },

  onMainWindowLoad({ window }) {
    this.registerMenus(window);
  },

  onMainWindowUnload({ window }) {
    // Cleanup handled by Zotero.MenuManager or manual removal
  },

  registerMenus(window) {
    const doc = window.document;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) return;

    // Idempotent: remove any existing Zotero Voice Annotator menu items first
    const existingIds = ["zva-separator", "zva-annotate-one", "zva-annotate-all"];
    for (const id of existingIds) {
      const existing = doc.getElementById(id);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    // Separator
    const sep = doc.createXULElement("menuseparator");
    sep.id = "zva-separator";
    itemMenu.appendChild(sep);
    this.menuItems.push(sep);

    // Single-item action: right-click on an audio attachment
    const annotateOne = doc.createXULElement("menuitem");
    annotateOne.id = "zva-annotate-one";
    annotateOne.setAttribute("label", "Zotero Voice Annotator: Transcribe and Annotate");
    annotateOne.addEventListener("command", () => this.handleTranscribeCommand(window, false));
    itemMenu.appendChild(annotateOne);
    this.menuItems.push(annotateOne);

    // Bulk action: right-click on a source (or selection with multiple audio attachments)
    const annotateAll = doc.createXULElement("menuitem");
    annotateAll.id = "zva-annotate-all";
    annotateAll.setAttribute("label", "Zotero Voice Annotator: Transcribe and Annotate All");
    annotateAll.addEventListener("command", () => this.handleTranscribeCommand(window, true));
    itemMenu.appendChild(annotateAll);
    this.menuItems.push(annotateAll);

    // Show/hide based on selection
    const onPopupShowing = () => {
      const items = window.ZoteroPane.getSelectedItems();
      const directAudio = items.filter(item => this.isAudioAttachment(item));
      const allAudio = this.getAudioAttachmentsFromItems(items);
      const sourceAudioCount = allAudio.length - directAudio.length;
      const hasSourceWithAudio = sourceAudioCount > 0;

      annotateOne.hidden = directAudio.length === 0;
      annotateAll.hidden = !hasSourceWithAudio && directAudio.length <= 1;
      const anyVisible = !annotateOne.hidden || !annotateAll.hidden;
      sep.hidden = !anyVisible;
    };

    // Remove any previously attached listener to avoid duplicates on reload
    if (itemMenu._mvPopupShowingHandler) {
      itemMenu.removeEventListener("popupshowing", itemMenu._mvPopupShowingHandler);
    }
    itemMenu._mvPopupShowingHandler = onPopupShowing;
    itemMenu.addEventListener("popupshowing", onPopupShowing);
  },

  unregisterMenus() {
    // Remove menu elements from all windows by ID
    const ids = ["zva-separator", "zva-annotate-one", "zva-annotate-all"];
    for (const win of Zotero.getMainWindows()) {
      const doc = win.document;
      for (const id of ids) {
        const elem = doc.getElementById(id);
        if (elem && elem.parentNode) {
          elem.parentNode.removeChild(elem);
        }
      }
    }
    this.menuItems = [];
  },

  // ---------------------------------------------------------------
  // Live Voice Annotation
  // ---------------------------------------------------------------

  registerReaderIntegration() {
    if (!Zotero.Reader || typeof Zotero.Reader.registerEventListener !== "function") {
      this.log("warn", "Zotero.Reader.registerEventListener unavailable; live annotation disabled");
      return;
    }
    this.log("info", "Registering PDF reader integration (live voice annotation)");
    Zotero.Reader.registerEventListener("renderToolbar", (event) => {
      if (!event.reader || event.reader.type !== "pdf") return;
      try {
        // Toolbar button (documented append() path)
        const button = this.createToolbarButton(event.reader, event.doc);
        if (button && typeof event.append === "function") {
          event.append(button);
        }
        // Shortcut handler lives in the reader iframe document so it is
        // available even before live mode starts. The overlay is created
        // on demand in enterLive().
        this.attachShortcutHandler(event.reader, event.doc);
      } catch (e) {
        this.log("error", "renderToolbar injection failed:", e);
      }
    }, this.id);
  },

  createToolbarButton(reader, doc) {
    if (doc.getElementById("zva-toggle-button")) return null;
    const button = doc.createElement("button");
    button.id = "zva-toggle-button";
    button.className = "toolbar-button";
    button.title = "Zotero Voice Annotator: Live Voice Annotation";
    button.textContent = "🎙";
    button.style.fontSize = "13px";
    button.style.cursor = "pointer";
    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.toggleLive(reader);
    });
    this.live.toolbarButtons.push({ reader, button });
    return button;
  },

  createLiveOverlay(reader, doc) {
    if (!doc || !doc.body) return null;
    if (Zotero.Prefs.get("extensions.zotero-voice-annotator.liveShowOverlay", true) === false) return null;
    const existing = doc.getElementById("zva-overlay");
    if (existing) {
      existing.style.display = "";
      this.renderOverlayTriggers(existing, doc);
      this.updateLiveOverlayStatus(doc, "listening");
      return existing;
    }

    const overlay = doc.createElement("div");
    overlay.id = "zva-overlay";
    overlay.style.cssText =
      "position: fixed; z-index: 99999; width: 220px; background: rgba(255,255,255,0.96);" +
      "border: 1px solid #bbb; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);" +
      "font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 12px; color: #333;" +
      "user-select: none; -moz-window-dragging: no-drag;";

    const header = doc.createElement("div");
    header.id = "zva-overlay-header";
    header.style.cssText =
      "display: flex; align-items: center; justify-content: space-between; padding: 5px 8px;" +
      "background: #2c3e50; color: #fff; border-radius: 5px 5px 0 0; cursor: move; font-weight: 600;" +
      "-moz-window-dragging: no-drag;";
    const title = doc.createElement("span");
    title.textContent = "Zotero Voice Annotator";
    const minimize = doc.createElement("button");
    minimize.textContent = "–";
    minimize.title = "Minimize";
    minimize.style.cssText =
      "background: transparent; color: #fff; border: none; cursor: pointer; font-size: 14px; line-height: 1;";
    header.appendChild(title);
    header.appendChild(minimize);

    const status = doc.createElement("div");
    status.id = "zva-overlay-status";
    status.style.cssText = "padding: 4px 8px; font-weight: 600; border-bottom: 1px solid #eee;";
    status.textContent = "Listening…";

    const list = doc.createElement("div");
    list.id = "zva-overlay-triggers";
    list.style.cssText = "padding: 6px 8px; max-height: 180px; overflow-y: auto;";

    overlay.appendChild(header);
    overlay.appendChild(status);
    overlay.appendChild(list);
    doc.body.appendChild(overlay);
    if (!this.live.overlayDocs.includes(doc)) this.live.overlayDocs.push(doc);

    this.positionOverlay(overlay, doc);
    this.renderOverlayTriggers(overlay, doc);
    this.updateLiveOverlayStatus(doc, "listening");

    minimize.addEventListener("click", () => {
      const collapsed = overlay.dataset.collapsed === "true";
      overlay.dataset.collapsed = String(!collapsed);
      list.style.display = collapsed ? "" : "none";
      status.style.display = collapsed ? "" : "none";
      minimize.textContent = collapsed ? "–" : "+";
      overlay.style.width = collapsed ? "220px" : "130px";
    });

    this.makeDraggable(header, overlay, doc);
    return overlay;
  },

  positionOverlay(overlay, doc) {
    const pos = this.getOverlayPos();
    if (pos && typeof pos.x === "number") {
      overlay.style.right = "auto";
      overlay.style.left = pos.x + "px";
      overlay.style.top = pos.y + "px";
    } else {
      // Default to the top-right corner of the PDF view, just below the
      // reader's 41px toolbar so we don't sit on top of it.
      let top = 46;
      try {
        const toolbar = doc && doc.querySelector(".toolbar");
        if (toolbar) {
          const h = toolbar.getBoundingClientRect().height;
          if (h > 0) top = h + 5;
        }
      } catch (e) {}
      overlay.style.right = "16px";
      overlay.style.top = top + "px";
    }
  },

  getOverlayPos() {
    try {
      const raw = Zotero.Prefs.get("extensions.zotero-voice-annotator.liveOverlayPos", true);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      return (pos && typeof pos.x === "number" && typeof pos.y === "number") ? pos : null;
    } catch (e) {
      return null;
    }
  },

  setOverlayPos(pos) {
    try {
      Zotero.Prefs.set("extensions.zotero-voice-annotator.liveOverlayPos", JSON.stringify(pos), true);
    } catch (e) {
      this.log("debug", "setOverlayPos:", e.message);
    }
  },

  makeDraggable(header, overlay, doc) {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
      e.stopPropagation();
    });

    const onMove = (e) => {
      if (!dragging) return;
      const win = doc.defaultView;
      let dx = e.clientX - startX;
      let dy = e.clientY - startY;
      // Keep the overlay fully inside the iframe viewport
      const rect = overlay.getBoundingClientRect();
      let left = origX + dx;
      let top = origY + dy;
      if (win) {
        left = Math.min(Math.max(0, left), Math.max(0, win.innerWidth - rect.width));
        top = Math.min(Math.max(0, top), Math.max(0, win.innerHeight - rect.height));
      }
      overlay.style.right = "auto";
      overlay.style.left = left + "px";
      overlay.style.top = top + "px";
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      const rect = overlay.getBoundingClientRect();
      this.setOverlayPos({ x: Math.round(rect.left), y: Math.round(rect.top) });
    };

    doc.defaultView.addEventListener("mousemove", onMove);
    doc.defaultView.addEventListener("mouseup", onUp);
  },

  renderOverlayTriggers(overlay, doc) {
    const list = overlay.querySelector("#zva-overlay-triggers");
    if (!list) return;
    list.textContent = "";
    const triggers = this.getTriggers();
    for (const t of triggers) {
      const row = doc.createElement("div");
      row.style.cssText = "display: flex; align-items: center; margin: 2px 0;";
      const swatch = doc.createElement("span");
      swatch.style.cssText = `display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; flex: none; background: ${t.color || "#ffd400"};`;
      const label = doc.createElement("span");
      label.textContent = t.phrase;
      row.appendChild(swatch);
      row.appendChild(label);
      list.appendChild(row);
    }
  },

  updateLiveOverlayStatus(doc, status) {
    const overlay = doc && doc.getElementById("zva-overlay");
    const el = overlay && overlay.querySelector("#zva-overlay-status");
    if (!el) return;
    const map = {
      idle: ["Idle", "#888"],
      listening: ["Listening…", "#2ecc71"],
      processing: ["Processing…", "#e67e22"],
      error: ["Error", "#e74c3c"]
    };
    const [text, color] = map[status] || map.idle;
    el.textContent = text;
    el.style.color = color;
  },

  updateLiveOverlayForReader(reader, status) {
    const doc = this.getReaderDoc(reader);
    if (doc) this.updateLiveOverlayStatus(doc, status);
  },

  getReaderDoc(reader) {
    if (!reader) return null;
    return (reader._iframeWindow && reader._iframeWindow.document) || null;
  },

  attachShortcutHandler(reader, doc) {
    if (!doc || doc._mvShortcutAttached) return;
    doc._mvShortcutAttached = true;
    const shortcut = this.parseShortcut(this.getLiveShortcut());
    if (!shortcut) return;

    doc.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!this.matchesShortcut(e, shortcut)) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = this.getLiveMode();
      if (mode === "push") {
        this.startCaptureForReader(reader);
      } else {
        this.toggleLive(reader);
      }
    }, true);

    doc.addEventListener("keyup", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!this.matchesShortcut(e, shortcut)) return;
      if (this.getLiveMode() === "push") {
        this.stopCaptureForReader(reader, false);
      }
    }, true);
  },

  getLiveMode() {
    return Zotero.Prefs.get("extensions.zotero-voice-annotator.liveMode", true) || "toggle";
  },

  getLiveShortcut() {
    return Zotero.Prefs.get("extensions.zotero-voice-annotator.liveShortcut", true) || "CmdOrCtrl+Shift+V";
  },

  parseShortcut(str) {
    if (!str) return null;
    const parts = str.split("+").map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const key = parts.pop();
    return { key: this.canonicalKey(key), mods: parts };
  },

  canonicalKey(k) {
    if (!k) return null;
    if (k === " " || k.toLowerCase() === "space") return "SPACE";
    return k.toUpperCase();
  },

  matchesShortcut(e, parsed) {
    if (!parsed) return false;
    const modsOK = parsed.mods.every(m => {
      if (m === "CmdOrCtrl" || m === "CmdCtrl") return e.metaKey || e.ctrlKey;
      if (m === "Ctrl" || m === "Control") return e.ctrlKey;
      if (m === "Cmd" || m === "Meta") return e.metaKey;
      if (m === "Alt" || m === "Option") return e.altKey;
      if (m === "Shift") return e.shiftKey;
      return false;
    });
    if (!modsOK) return false;
    const key = this.canonicalKey(e.key);
    return key !== null && key === parsed.key;
  },

  async toggleLive(reader) {
    try {
      if (this.live.active) {
        if (this.live.reader !== reader) {
          // Live is running in another reader; stop it there first
          await this.exitLive();
          await this.enterLive(reader);
        } else {
          await this.exitLive();
        }
      } else {
        await this.enterLive(reader);
      }
    } catch (err) {
      this.log("error", "toggleLive error:", err);
      this.updateLiveOverlayForReader(reader, "error");
    }
  },

  async enterLive(reader) {
    if (!reader || !reader.itemID) {
      const win = Zotero.getMainWindows()[0];
      Zotero.alert(win, "Zotero Voice Annotator", "Open a PDF in the reader to start live annotation.");
      return;
    }
    if (this.live.active) return;
    this.live.reader = reader;
    this.live.pdfItem = Zotero.Items.get(reader.itemID);
    if (!this.live.pdfItem) throw new Error("Cannot resolve PDF item.");
    this.live.pdfPath = await this.live.pdfItem.getFilePathAsync();
    if (!this.live.pdfPath) throw new Error("Cannot access PDF file path.");
    this.live.active = true;
    this.log("info", "Live voice annotation started for item", reader.itemID);
    this.setToolbarState(true);
    // Show the trigger/status overlay only while live mode is active
    const doc = this.getReaderDoc(reader);
    if (doc) this.createLiveOverlay(reader, doc);
    this.updateLiveOverlayForReader(reader, "listening");
    await this.startCapture();
  },

  async exitLive() {
    if (!this.live.active && !this.live.capturing) return;
    await this.stopCapture(true);
  },

  async startCaptureForReader(reader) {
    try {
      if (this.live.active && this.live.reader !== reader) {
        await this.exitLive();
      }
      if (this.live.active) {
        await this.startCapture();
      } else {
        await this.enterLive(reader);
      }
    } catch (e) {
      this.log("error", "startCaptureForReader:", e);
    }
  },

  async stopCaptureForReader(reader, final) {
    try {
      await this.stopCapture(final);
    } catch (e) {
      this.log("error", "stopCaptureForReader:", e);
    }
  },

  async startCapture() {
    if (this.live.capturing) return;
    const pythonPath = this.getPythonPath();
    const helperPath = this.getHelperScriptPath();
    const model = Zotero.Prefs.get("extensions.zotero-voice-annotator.whisperModel", true) || "base";
    const flushInterval = Number(Zotero.Prefs.get("extensions.zotero-voice-annotator.liveFlushInterval", true)) || 2;

    const tmpDir = Zotero.getTempDirectory();
    const outFile = tmpDir.clone();
    outFile.append("zva_stream_" + Zotero.Utilities.randomString(8) + ".jsonl");
    const stopFile = tmpDir.clone();
    stopFile.append("zva_stop_" + Zotero.Utilities.randomString(8) + ".txt");

    this.live.streamOutPath = outFile.path;
    this.live.stopFilePath = stopFile.path;
    this.live.partialLine = "";
    this.live.lastRead = 0;
    this.live.streamDone = false;

    const args = [
      helperPath, "stream",
      "--model", model,
      "--flush-interval", String(flushInterval),
      "--stop-file", stopFile.path,
      "--output-file", outFile.path
    ];
    this.log("info", "Starting live capture:", pythonPath, args.join(" "));

    this.live.capturing = true;
    try {
      this.live.processPromise = this.runCommandAsync(pythonPath, args);
      // Avoid unhandled rejection if the process fails to start
      this.live.processPromise.catch(e => this.log("warn", "Live stream process error:", e.message));
    } catch (err) {
      this.live.capturing = false;
      this.updateLiveOverlayForReader(this.live.reader, "error");
      throw err;
    }

    if (this.live.pollTimer) clearInterval(this.live.pollTimer);
    this.live.pollTimer = setInterval(() => {
      this.pollStreamOutput().catch(e => this.log("debug", "poll error:", e.message));
    }, 300);
  },

  async stopCapture(final) {
    if (!this.live.capturing) {
      if (final) this.cleanupLive();
      return;
    }
    this.live.capturing = false;
    if (this.live.pollTimer) {
      clearInterval(this.live.pollTimer);
      this.live.pollTimer = null;
    }

    // Signal the Python process to stop (it flushes remaining audio, then exits)
    if (this.live.stopFilePath) {
      try {
        await Zotero.File.putContentsAsync(this.live.stopFilePath, "stop");
      } catch (e) {
        this.log("debug", "stop signal:", e.message);
      }
    }

    if (this.live.processPromise) {
      try {
        await Promise.race([this.live.processPromise, Zotero.Promise.delay(15000)]);
      } catch (e) {
        this.log("warn", "Stream process did not exit cleanly:", e.message);
      }
    }

    // Pick up any remaining output and force-resolve pending triggers
    try { await this.pollStreamOutput(); } catch (e) {}
    try { await this.processStreamWords(true); } catch (e) {}

    if (final) {
      this.cleanupLive();
    } else {
      this.updateLiveOverlayForReader(this.live.reader, "idle");
    }
  },

  cleanupLive() {
    const doc = this.getReaderDoc(this.live.reader);
    // Remove the overlay when live mode ends
    if (doc) {
      try {
        const overlay = doc.getElementById("zva-overlay");
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
      const idx = this.live.overlayDocs.indexOf(doc);
      if (idx !== -1) this.live.overlayDocs.splice(idx, 1);
    }
    this.live.active = false;
    this.live.capturing = false;
    this.live.reader = null;
    this.live.pdfItem = null;
    this.live.pdfPath = null;
    this.live.processPromise = null;
    this.live.words = [];
    this.live.pendingTriggers = [];
    this.live.detectedStarts = new Set();
    this.live.scannedWords = 0;
    this.live.streamDone = false;
    this.live.queue = Promise.resolve();
    if (this.live.streamOutPath) { try { this.removeFile(this.live.streamOutPath); } catch (e) {} }
    if (this.live.stopFilePath) { try { this.removeFile(this.live.stopFilePath); } catch (e) {} }
    this.live.streamOutPath = null;
    this.live.stopFilePath = null;
    this.setToolbarState(false);
    if (doc) this.updateLiveOverlayStatus(doc, "idle");
  },

  async pollStreamOutput() {
    if (!this.live.active && !this.live.capturing) return;

    // Stop if the reader/document that owns this session is gone
    if (this.live.capturing && this.live.reader) {
      let alive = false;
      try {
        const doc = this.getReaderDoc(this.live.reader);
        alive = !!(doc && doc.body && doc.defaultView);
      } catch (e) {
        alive = false;
      }
      if (!alive) {
        this.log("warn", "Reader no longer available; stopping live annotation");
        await this.exitLive();
        return;
      }
    }

    if (!this.live.streamOutPath) return;
    let text;
    try {
      text = await Zotero.File.getContentsAsync(this.live.streamOutPath);
    } catch (e) {
      return; // output file not created yet
    }

    if (text.length > this.live.lastRead) {
      this.live.partialLine += text.slice(this.live.lastRead);
      this.live.lastRead = text.length;
      const lines = this.live.partialLine.split("\n");
      this.live.partialLine = lines.pop(); // may be an incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.handleStreamLine(trimmed);
      }
    }

    await this.processStreamWords(false);
  },

  handleStreamLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (obj.type === "ready") {
      this.log("info", "Live capture ready");
      this.updateLiveOverlayForReader(this.live.reader, "listening");
    } else if (obj.type === "words") {
      if (Array.isArray(obj.words) && obj.words.length > 0) {
        for (const w of obj.words) {
          this.live.words.push({
            word: (w.word || "").trim(),
            normalized: w.normalized || this.normalizeWord(w.word || ""),
            start: typeof w.start === "number" ? w.start : null,
            end: typeof w.end === "number" ? w.end : null
          });
        }
        this.log("debug", `Live: received ${obj.words.length} words (total ${this.live.words.length})`);
        this.updateLiveOverlayForReader(this.live.reader, "processing");
      }
    } else if (obj.type === "done") {
      this.live.streamDone = true;
    } else if (obj.type === "error") {
      this.log("error", "Live capture error:", obj.error);
      this.updateLiveOverlayForReader(this.live.reader, "error");
      // The stream is unusable; tear down.
      this.exitLive().catch(e => this.log("warn", "exitLive after error:", e));
    }
  },

  processStreamWords(force) {
    if (!this.live.active && !force) return;
    if (!this.live.queue) this.live.queue = Promise.resolve();
    this.live.queue = this.live.queue
      .then(() => this.doProcessStreamWords(force))
      .catch(e => this.log("error", "processStreamWords:", e));
    return this.live.queue;
  },

  async doProcessStreamWords(force) {
    try {
      if (!this.live.active && !force) return;
      this.scanForStreamTriggers();
      const pending = this.live.pendingTriggers.filter(t => !t.resolved);
      if (pending.length === 0) {
        this.updateLiveOverlayForReader(this.live.reader, "listening");
        return;
      }

      const silenceTimeout = this.getSilenceTimeout();
      const maxQuoteWords = 12;
      const available = this.live.words.length;

      const resolvable = [];
      for (const occ of pending) {
        let boundary = occ.endWordIndex + maxQuoteWords;
        const nextTrigger = pending.find(t => t.startWordIndex > occ.startWordIndex);
        if (nextTrigger) boundary = Math.min(boundary, nextTrigger.startWordIndex);

        let silenceBoundary = null;
        if (silenceTimeout && silenceTimeout > 0) {
          for (let j = occ.endWordIndex; j < this.live.words.length - 1; j++) {
            const gap = this.live.words[j + 1].start - this.live.words[j].end;
            if (gap >= silenceTimeout) {
              silenceBoundary = j + 1;
              break;
            }
          }
        }
        if (silenceBoundary !== null) boundary = Math.min(boundary, silenceBoundary);

        const canResolve = force || silenceBoundary !== null || !!nextTrigger || available >= boundary;
        if (canResolve) {
          resolvable.push({ occ, boundary: Math.min(boundary, available) });
        }
      }

      for (const { occ, boundary } of resolvable) {
        occ.resolved = true;
        this.updateLiveOverlayForReader(this.live.reader, "processing");
        await this.resolveLiveTrigger(occ, boundary);
      }

      if (this.live.active) {
        this.updateLiveOverlayForReader(this.live.reader, "listening");
      }
    } catch (e) {
      this.log("error", "doProcessStreamWords:", e);
    }
  },

  scanForStreamTriggers() {
    const triggers = this.getTriggers();
    const maxLen = triggers.reduce((m, t) => Math.max(m, t.phrase.split(/\s+/).filter(Boolean).length), 1);
    const scanFrom = Math.max(0, this.live.scannedWords - maxLen + 1);
    if (scanFrom >= this.live.words.length) return;

    const slice = this.live.words.slice(scanFrom);
    const occs = this.findTriggerOccurrences(slice, triggers);
    for (const o of occs) {
      const start = scanFrom + o.startWordIndex;
      const end = scanFrom + o.endWordIndex;
      if (this.live.detectedStarts.has(start)) continue;
      this.live.detectedStarts.add(start);
      this.live.pendingTriggers.push({
        startWordIndex: start,
        endWordIndex: end,
        phrase: o.phrase,
        color: o.color,
        resolved: false
      });
      this.log("info", `Live trigger '${o.phrase}' detected at word ${start}`);
    }
    this.live.scannedWords = this.live.words.length;
  },

  async resolveLiveTrigger(occ, boundary) {
    try {
      if (!this.live.pdfPath) return;
      const contentWords = this.live.words.slice(occ.endWordIndex, boundary);
      if (contentWords.length === 0) return;

      // Progressively match the spoken words after the trigger against the PDF
      const maxWords = Math.min(6, contentWords.length);
      let matchedCount = 0;
      for (let count = maxWords; count >= 1; count--) {
        const probe = contentWords.slice(0, count).map(w => w.word).join(" ");
        const m = await this.matchQuoteInPDF(this.live.pdfPath, probe);
        if (m) {
          matchedCount = count;
          break;
        }
      }
      if (matchedCount === 0) {
        this.log("info", `Live trigger '${occ.phrase}' at word ${occ.startWordIndex} did not match the PDF; skipping`);
        return;
      }

      const segment = {
        trigger: occ.phrase,
        color: occ.color,
        quoteCandidate: contentWords.slice(0, matchedCount).map(w => w.word).join(" "),
        commentary: contentWords.slice(matchedCount).map(w => w.word).join(" "),
        words: contentWords,
        matchedCount
      };
      await this.annotateLiveSegment(segment);
    } catch (e) {
      this.log("error", "resolveLiveTrigger:", e);
    }
  },

  async annotateLiveSegment(segment) {
    const pdfPath = this.live.pdfPath;
    const pdfItem = this.live.pdfItem;
    this.log("info", `Live segment for trigger '${segment.trigger}': quote='${segment.quoteCandidate}'`);

    const match = await this.matchQuoteInPDF(pdfPath, segment.quoteCandidate);
    if (!match) {
      this.log("warn", "Live: no match for quote:", segment.quoteCandidate);
      return;
    }

    const expanded = this.expandQuoteToSpokenWords(segment, match);
    const quoteCandidate = expanded.quoteCandidate;
    const commentary = expanded.commentary || match.commentary || "";

    const finalMatch = quoteCandidate !== segment.quoteCandidate
      ? (await this.matchQuoteInPDF(pdfPath, quoteCandidate)) || match
      : match;

    const appendToExisting = Zotero.Prefs.get("extensions.zotero-voice-annotator.skipDuplicates", true) !== false;
    const existingAnnotation = appendToExisting ? await this.findExistingAnnotation(pdfItem, finalMatch.sentence, finalMatch) : null;
    if (existingAnnotation) {
      await this.appendCommentaryToAnnotation(existingAnnotation, commentary);
      this.log("info", "Live: appended commentary:", finalMatch.sentence);
    } else {
      await this.createHighlightAnnotation(pdfItem, finalMatch.sentence, commentary, finalMatch, segment.color);
      this.log("info", "Live: created annotation:", finalMatch.sentence);
    }
  },

  setToolbarState(active) {
    for (const tb of this.live.toolbarButtons) {
      if (active) {
        const isThisReader = this.live.reader && tb.reader.itemID === this.live.reader.itemID;
        if (!isThisReader) continue;
      }
      tb.button.title = active
        ? "Zotero Voice Annotator: Stop Live Annotation"
        : "Zotero Voice Annotator: Live Voice Annotation";
      tb.button.style.background = active ? "#2ecc71" : "";
    }
  },

  async runCommandAsync(cmdPath, args) {
    const cmdFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    cmdFile.initWithPath(cmdPath);
    if (!cmdFile.exists()) {
      throw new Error(`Command not found: ${cmdPath}`);
    }
    const process = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    process.init(cmdFile);
    process.startHidden = true;

    return new Promise((resolve, reject) => {
      const observer = {
        observe(subject, topic) {
          if (topic === "process-finished") {
            resolve(subject.exitValue);
          } else if (topic === "process-failed") {
            reject(new Error("Process failed to start"));
          }
        }
      };
      try {
        if (Zotero.isWin && process.runwAsync) {
          process.runwAsync(args, args.length, observer);
        } else {
          process.runAsync(args, args.length, observer);
        }
      } catch (e) {
        reject(e);
      }
    });
  },

  removeFile(path) {
    const f = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    f.initWithPath(path);
    if (f.exists()) f.remove(false);
  },

  isAudioAttachment(item) {
    if (!item || !item.isAttachment()) return false;
    const contentType = item.attachmentContentType || "";
    const filename = item.attachmentFilename || "";
    const audioTypes = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac"];
    const audioExts = [".mp3", ".m4a", ".wav", ".ogg", ".flac"];
    return audioTypes.includes(contentType) || audioExts.some(ext => filename.toLowerCase().endsWith(ext));
  },

  getParentPDFAttachments(audioItem) {
    const parentID = audioItem.parentID;
    if (!parentID) return [];
    const parent = Zotero.Items.get(parentID);
    if (!parent) return [];
    const attachments = parent.getAttachments();
    return Zotero.Items.get(attachments).filter(att => att.isPDFAttachment());
  },

  getAudioAttachmentsFromItems(items) {
    const audioItems = [];
    const seen = new Set();
    for (const item of items) {
      if (this.isAudioAttachment(item)) {
        if (!seen.has(item.id)) {
          audioItems.push(item);
          seen.add(item.id);
        }
        continue;
      }
      // If a regular item is selected, include its audio attachments
      if (item.isRegularItem && item.isRegularItem()) {
        const attachments = Zotero.Items.get(item.getAttachments());
        for (const att of attachments) {
          if (this.isAudioAttachment(att) && !seen.has(att.id)) {
            audioItems.push(att);
            seen.add(att.id);
          }
        }
      }
    }
    return audioItems;
  },

  async handleTranscribeCommand(window, processAll) {
    const items = window.ZoteroPane.getSelectedItems();
    const audioItems = this.getAudioAttachmentsFromItems(items);
    if (audioItems.length === 0) {
      window.alert("No audio file selected.");
      return;
    }

    const toProcess = processAll ? audioItems : [audioItems[0]];
    this.log("info", `Processing ${toProcess.length} audio file(s) (processAll=${processAll})`);

    const progress = new Zotero.ProgressWindow({ window });
    progress.changeHeadline("Zotero Voice Annotator");
    progress.show();

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const audioItem of toProcess) {
      processed++;
      const title = audioItem.getField("title") || "audio file";
      this.log("info", `Starting audio ${processed}/${toProcess.length}: ${title}`);
      const itemProgress = new progress.ItemProgress("audio", `Processing ${title}...`);
      try {
        await this.transcribeAndAnnotate(audioItem);
        itemProgress.setProgress(100);
        itemProgress.setText("Done");
        succeeded++;
        this.log("info", `Finished audio ${processed}/${toProcess.length}: ${title}`);
      } catch (err) {
        this.log("error", "Failed to process audio:", err);
        itemProgress.setError();
        const msg = err && (err.message || err.stack || String(err)) || "Unknown error";
        itemProgress.setText(`Error: ${msg}`);
        failed++;
      }
    }

    this.log("info", `Completed batch: ${succeeded} succeeded, ${failed} failed out of ${processed}`);
    progress.startCloseTimer(5000);
  },

  async transcribeAndAnnotate(audioItem) {
    // Get audio file path
    const audioPath = await audioItem.getFilePathAsync();
    if (!audioPath) throw new Error("Cannot access audio file path.");

    // Get parent PDF attachments
    const pdfAttachments = this.getParentPDFAttachments(audioItem);
    if (pdfAttachments.length === 0) {
      throw new Error("No PDF attachment found on parent item.");
    }
    const pdfItem = pdfAttachments[0];
    const pdfPath = await pdfItem.getFilePathAsync();

    // Transcribe audio
    this.log("info", "Transcribing:", audioPath);
    const transcription = await this.transcribeAudio(audioPath);
    const transcriptText = typeof transcription === "object" && transcription.text ? transcription.text : String(transcription);
    const transcriptWords = (typeof transcription === "object" && Array.isArray(transcription.words)) ? transcription.words : null;
    this.log("info", "Transcript:", transcriptText);
    if (transcriptWords) {
      this.log("debug", "Word timestamps:", transcriptWords.length, "words");
    }

    // Find quote segments. Only treat a trigger phrase as a keyword when the
    // words immediately following it actually match text in the PDF.
    const triggers = this.getTriggers();
    const silenceTimeout = this.getSilenceTimeout();
    const segments = await this.findQuoteSegments(transcriptText, triggers, pdfPath, transcriptWords, silenceTimeout);
    this.log("info", `Found ${segments.length} valid quote segments`);

    // Process each segment
    const appendToExisting = Zotero.Prefs.get("extensions.zotero-voice-annotator.skipDuplicates", true) !== false;

    let createdCount = 0;
    let appendedCount = 0;
    const warnings = [];

    for (const segment of segments) {
      try {
        this.log("info", `Segment for trigger '${segment.trigger}': initial quote='${segment.quoteCandidate}', commentary='${segment.commentary}'`);

        // Match quote in PDF and get exact position
        const match = await this.matchQuoteInPDF(pdfPath, segment.quoteCandidate);
        if (!match) {
          warnings.push(`Could not match quote: "${segment.quoteCandidate.substring(0, 50)}..."`);
          this.log("warn", "No match for quote:", segment.quoteCandidate);
          continue;
        }
        this.log("info", `PDF match: sentence='${match.sentence}', matched_words=${match.matched_words}, page=${match.pageIndex}`);

        // Expand the quote if the user continued reading the matched sentence.
        const expanded = this.expandQuoteToSpokenWords(segment, match);
        const quoteCandidate = expanded.quoteCandidate;
        const commentary = expanded.commentary || match.commentary || "";
        this.log("info", `After expansion: quote='${quoteCandidate}', commentary='${commentary}'`);

        // Re-match with the expanded quote to get the full sentence/rects
        const finalMatch = quoteCandidate !== segment.quoteCandidate
          ? (await this.matchQuoteInPDF(pdfPath, quoteCandidate)) || match
          : match;

        // Check for an existing highlight of the same sentence
        const existingAnnotation = appendToExisting ? await this.findExistingAnnotation(pdfItem, finalMatch.sentence, finalMatch) : null;
        if (existingAnnotation) {
          await this.appendCommentaryToAnnotation(existingAnnotation, commentary);
          appendedCount++;
          this.log("info", "Appended commentary to existing annotation:", finalMatch.sentence);
          continue;
        }

        // Create annotation with the color associated with the matched trigger
        await this.createHighlightAnnotation(pdfItem, finalMatch.sentence, commentary, finalMatch, segment.color);
        createdCount++;
      } catch (err) {
        this.log("error", "Error processing segment:", err);
        warnings.push(`Error: ${err.message}`);
      }
    }

    this.log("info", `Created ${createdCount} annotations, appended to ${appendedCount} existing annotations`);
    if (warnings.length > 0) {
      this.log("warn", "Warnings:", warnings);
    }

    return { created: createdCount, appended: appendedCount, warnings };
  },

  async transcribeAudio(audioPath) {
    const mode = Zotero.Prefs.get("extensions.zotero-voice-annotator.transcriptionMode", true) || "python";

    if (mode === "custom") {
      return this.transcribeWithCustomCommand(audioPath);
    }
    return this.transcribeWithPython(audioPath);
  },

  async transcribeWithPython(audioPath) {
    const pythonPath = this.getPythonPath();
    const helperPath = this.getHelperScriptPath();
    const model = Zotero.Prefs.get("extensions.zotero-voice-annotator.whisperModel", true) || "base";

    const tmpFile = Zotero.getTempDirectory();
    tmpFile.append("zva_transcript.json");
    tmpFile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o666);

    const args = [helperPath, "transcribe", "--audio", audioPath, "--model", model, "--output", tmpFile.path];
    this.log("debug", "Running:", pythonPath, args.join(" "));

    await this.runCommand(pythonPath, args);

    const output = await Zotero.File.getContentsAsync(tmpFile);
    tmpFile.remove(false);

    this.log("debug", "Helper output:", output);
    const json = JSON.parse(output);
    if (json.error) {
      this.log("error", "Transcription helper reported error:", json.error);
      throw new Error(json.error);
    }
    return {
      text: json.text || "",
      words: json.words || null,
      language: json.language,
      duration: json.duration
    };
  },

  async transcribeWithCustomCommand(audioPath) {
    const cmdPath = Zotero.Prefs.get("extensions.zotero-voice-annotator.customCommandPath", true);
    if (!cmdPath) throw new Error("Custom command path not configured.");

    const tmpFile = Zotero.getTempDirectory();
    tmpFile.append("zva_transcript.json");
    tmpFile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o666);

    const argsStr = Zotero.Prefs.get("extensions.zotero-voice-annotator.customCommandArgs", true) || "";
    const args = argsStr.split(/\s+/).filter(Boolean).map(arg => arg.replace(/\{audio\}/g, audioPath));
    // If custom command doesn't support --output, we wrap it
    // For now, assume custom commands write to stdout and we capture via temp file
    await this.runCommandWithShellRedirect(cmdPath, args, tmpFile.path);

    const output = await Zotero.File.getContentsAsync(tmpFile);
    tmpFile.remove(false);

    try {
      const json = JSON.parse(output);
      if (json.text !== undefined) {
        return { text: json.text, words: json.words || null };
      }
      if (json.transcript !== undefined) {
        return { text: json.transcript, words: json.words || null };
      }
      return { text: output.trim(), words: null };
    } catch {
      return { text: output.trim(), words: null };
    }
  },

  async runCommand(cmdPath, args) {
    const cmdFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    cmdFile.initWithPath(cmdPath);

    if (!cmdFile.exists()) {
      throw new Error(`Command not found: ${cmdPath}`);
    }

    const process = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    process.init(cmdFile);
    process.startHidden = true;

    // Use runw for unicode support on Windows, run otherwise
    const useUnicode = Zotero.isWin;
    const exitCode = await new Promise((resolve, reject) => {
      const observer = {
        observe(subject, topic) {
          if (topic === "process-finished") {
            resolve(subject.exitValue);
          } else if (topic === "process-failed") {
            reject(new Error("Process failed to start"));
          }
        }
      };
      try {
        if (useUnicode && process.runwAsync) {
          process.runwAsync(args, args.length, observer);
        } else {
          process.runAsync(args, args.length, observer);
        }
      } catch (e) {
        reject(e);
      }
    });

    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${cmdPath} ${args.join(" ")}`);
    }
  },

  async runCommandWithShellRedirect(cmdPath, args, outputPath) {
    // Cross-platform shell redirect
    const isWin = Zotero.isWin;
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellFile = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    shellFile.initWithPath(shell);

    const process = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    process.init(shellFile);
    process.startHidden = true;

    const quotedCmd = this.escapeShellArg(cmdPath);
    const quotedArgs = args.map(a => this.escapeShellArg(a)).join(" ");
    const redirectCmd = isWin
      ? `${quotedCmd} ${quotedArgs} > "${outputPath}" 2>&1`
      : `${quotedCmd} ${quotedArgs} > ${this.escapeShellArg(outputPath)} 2>&1`;

    const shellArgs = isWin ? ["/c", redirectCmd] : ["-c", redirectCmd];

    const exitCode = await new Promise((resolve, reject) => {
      const observer = {
        observe(subject, topic) {
          if (topic === "process-finished") {
            resolve(subject.exitValue);
          } else if (topic === "process-failed") {
            reject(new Error("Shell process failed to start"));
          }
        }
      };
      try {
        if (Zotero.isWin && process.runwAsync) {
          process.runwAsync(shellArgs, shellArgs.length, observer);
        } else {
          process.runAsync(shellArgs, shellArgs.length, observer);
        }
      } catch (e) {
        reject(e);
      }
    });

    if (exitCode !== 0) {
      throw new Error(`Shell command failed with exit code ${exitCode}`);
    }
  },

  escapeShellArg(arg) {
    if (Zotero.isWin) {
      // Simple Windows quoting
      if (!/\s/.test(arg)) return arg;
      return `"${arg.replace(/"/g, "\"\"")}"`;
    }
    return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
  },

  getPythonPath() {
    const configured = Zotero.Prefs.get("extensions.zotero-voice-annotator.pythonPath", true);
    if (configured) return configured;
    // Try common paths
    const candidates = ["/usr/bin/python3", "/usr/local/bin/python3", "python3", "python"];
    return candidates[0];
  },

  getHelperScriptPath() {
    const configured = Zotero.Prefs.get("extensions.zotero-voice-annotator.helperScriptPath", true);
    if (configured) return configured;
    if (!this.helperScriptTempPath) {
      throw new Error("Helper script has not been extracted. Please restart Zotero.");
    }
    return this.helperScriptTempPath;
  },

  async findQuoteSegments(transcript, triggers, pdfPath, words, silenceTimeout) {
    // Build word list from transcript if timestamps weren't provided
    const wordList = this.buildWordList(transcript, words);
    if (wordList.length === 0) return [];

    // Find all trigger occurrences. Prefer longer triggers and earlier positions.
    const occurrences = this.findTriggerOccurrences(wordList, triggers);

    // First pass: test each trigger occurrence against the PDF to find valid ones.
    const candidateSegments = [];
    for (const occ of occurrences) {
      const contentWords = wordList.slice(occ.endWordIndex);
      const maxWords = Math.min(6, contentWords.length);
      const minWords = Math.min(1, contentWords.length);

      if (maxWords < minWords || minWords < 1) continue;

      this.log("info", `Trigger '${occ.phrase}' at word ${occ.startWordIndex}: trying ${minWords}-${maxWords} words`);

      let matchedCount = 0;
      for (let count = maxWords; count >= minWords; count--) {
        const probeWords = contentWords.slice(0, count);
        const probe = probeWords.map(w => w.word).join(" ");
        const match = await this.matchQuoteInPDF(pdfPath, probe);
        if (match) {
          matchedCount = count;
          this.log("info", `Matched ${count} words: '${probe}'`);
          break;
        }
      }

      candidateSegments.push({
        startWordIndex: occ.startWordIndex,
        endWordIndex: occ.endWordIndex,
        phrase: occ.phrase,
        color: occ.color,
        contentWords,
        matchedCount,
        valid: matchedCount > 0
      });
    }

    const validSegments = candidateSegments.filter(s => s.valid);

    // Second pass: determine segment boundaries considering next trigger and silence gaps.
    const finalSegments = [];
    for (let i = 0; i < validSegments.length; i++) {
      const current = validSegments[i];
      const nextTrigger = (i + 1 < validSegments.length) ? validSegments[i + 1] : null;
      const nextTriggerStart = nextTrigger ? nextTrigger.startWordIndex : wordList.length;

      // Find boundary due to silence gap
      let silenceBoundary = nextTriggerStart;
      if (silenceTimeout && silenceTimeout > 0 && current.endWordIndex < nextTriggerStart) {
        for (let j = current.endWordIndex; j < nextTriggerStart - 1; j++) {
          const gap = wordList[j + 1].start - wordList[j].end;
          if (gap >= silenceTimeout) {
            silenceBoundary = j + 1;
            this.log("debug", `Silence gap ${gap.toFixed(2)}s at word ${j + 1}; ending segment`);
            break;
          }
        }
      }

      const segmentEnd = Math.min(nextTriggerStart, silenceBoundary);
      const segmentWords = wordList.slice(current.endWordIndex, segmentEnd);
      const quoteCandidate = segmentWords.slice(0, current.matchedCount).map(w => w.word).join(" ");
      const commentary = segmentWords.slice(current.matchedCount).map(w => w.word).join(" ");

      finalSegments.push({
        trigger: current.phrase,
        color: current.color,
        quoteCandidate,
        commentary,
        words: segmentWords,
        matchedCount: current.matchedCount
      });
    }

    // Log skipped triggers
    for (const s of candidateSegments) {
      if (!s.valid) {
        this.log("info", `Trigger '${s.phrase}' at word ${s.startWordIndex} did not match; skipping`);
      }
    }

    return finalSegments;
  },

  buildWordList(transcript, words) {
    if (words && Array.isArray(words) && words.length > 0) {
      return words.map(w => {
        const raw = (w.word || "").trim();
        return {
          word: raw,
          normalized: w.normalized || this.normalizeWord(raw),
          start: typeof w.start === "number" ? w.start : null,
          end: typeof w.end === "number" ? w.end : null
        };
      }).filter(w => w.word.length > 0);
    }

    // Fallback: split transcript into words without timestamps
    const parts = transcript.split(/\s+/).filter(w => w.length > 0);
    let time = 0;
    return parts.map((word, i) => ({
      word,
      normalized: this.normalizeWord(word),
      start: time + i * 0.1,
      end: time + (i + 1) * 0.1
    }));
  },

  normalizeWord(word) {
    return word.replace(/[^\w\-]/g, "").toLowerCase();
  },

  findTriggerOccurrences(wordList, triggers) {
    const occurrences = [];

    // Sort triggers by word count descending so longer phrases are checked first
    const sortedTriggers = triggers
      .map(t => ({ ...t, words: t.phrase.split(/\s+/).filter(w => w.length > 0) }))
      .filter(t => t.words.length > 0)
      .sort((a, b) => b.words.length - a.words.length);

    this.log("debug", "Looking for triggers:", sortedTriggers.map(t => t.phrase).join(", "));

    const used = new Array(wordList.length).fill(false);

    for (let i = 0; i < wordList.length; i++) {
      if (used[i]) continue;

      for (const trigger of sortedTriggers) {
        const tw = trigger.words;
        if (i + tw.length > wordList.length) continue;

        let match = true;
        for (let k = 0; k < tw.length; k++) {
          if (this.normalizeWord(tw[k]) !== wordList[i + k].normalized) {
            match = false;
            break;
          }
        }

        if (match) {
          const endIndex = i + tw.length;
          for (let k = i; k < endIndex; k++) used[k] = true;
          occurrences.push({
            startWordIndex: i,
            endWordIndex: endIndex,
            phrase: trigger.phrase,
            color: trigger.color || this.colors.yellow
          });
          this.log("debug", `Found trigger '${trigger.phrase}' at word ${i}`);
          // Skip past this trigger; do not check other triggers at same start position
          i = endIndex - 1;
          break;
        }
      }
    }

    this.log("info", `Found ${occurrences.length} trigger occurrence(s)`);
    return occurrences.sort((a, b) => a.startWordIndex - b.startWordIndex);
  },

  findQuoteInPDF(fullText, quoteCandidate, threshold) {
    // Normalize whitespace and lowercase
    const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const nCandidate = normalize(quoteCandidate);
    const candidateWords = nCandidate.split(/\s+/).filter(w => w.length > 0);

    if (candidateWords.length === 0) return null;

    // Try to match first 4-6 words progressively
    const maxWords = Math.min(6, candidateWords.length);
    const minWords = Math.min(4, candidateWords.length);

    for (let wordCount = maxWords; wordCount >= minWords; wordCount--) {
      const probeWords = candidateWords.slice(0, wordCount);
      const match = this.findRegexMatchInText(fullText, probeWords);
      if (match) {
        const commentaryWords = candidateWords.slice(wordCount);
        return {
          sentence: match.sentence,
          pageIndex: match.pageIndex,
          matchedWords: wordCount,
          commentary: commentaryWords.join(" ").trim()
        };
      }
    }

    // Fallback: fuzzy sentence-level matching
    if (candidateWords.length >= 3) {
      const sentences = this.extractSentences(fullText);
      let bestMatch = null;
      let bestScore = 0;

      for (const sentence of sentences) {
        const score = this.similarity(nCandidate, normalize(sentence.text));
        if (score > bestScore && score >= threshold) {
          bestScore = score;
          bestMatch = sentence;
        }
      }

      if (bestMatch) {
        return {
          sentence: bestMatch.text,
          pageIndex: bestMatch.pageIndex,
          matchedWords: 0,
          commentary: ""
        };
      }
    }

    return null;
  },

  // Build a regex that allows optional hyphens within words, then search original text
  findRegexMatchInText(fullText, words) {
    // Replace page separators with spaces for regex search, but keep original for position mapping
    const searchText = fullText.replace(/\f/g, " ");
    const patterns = words.map(w => w.replace(/-/g, "[-]?"));
    const regex = new RegExp(patterns.map(p => `(?:${p})`).join("\\s+"), "i");
    const match = searchText.match(regex);
    if (!match) return null;

    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const expanded = this.expandToSentence(fullText, matchStart, matchEnd - matchStart);
    return expanded;
  },

  extractSentences(text) {
    const sentences = [];
    const sentenceEnders = /[.!?]/;
    let current = "";
    let pageIndex = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\f") {
        pageIndex++;
        continue;
      }
      current += text[i];
      if (sentenceEnders.test(text[i])) {
        const trimmed = current.trim();
        if (trimmed.length > 10) {
          sentences.push({ text: trimmed, pageIndex });
        }
        current = "";
      }
    }

    if (current.trim().length > 10) {
      sentences.push({ text: current.trim(), pageIndex });
    }

    return sentences;
  },

  expandToSentence(text, start, length) {
    const sentenceEnders = /[.!?]/;
    let sentenceStart = start;
    while (sentenceStart > 0 && !sentenceEnders.test(text[sentenceStart - 1])) {
      sentenceStart--;
    }
    while (sentenceStart < text.length && /\s/.test(text[sentenceStart])) {
      sentenceStart++;
    }

    let sentenceEnd = start + length;
    while (sentenceEnd < text.length && !sentenceEnders.test(text[sentenceEnd])) {
      sentenceEnd++;
    }
    sentenceEnd++;

    const sentence = text.substring(sentenceStart, sentenceEnd).trim();
    const textBefore = text.substring(0, start);
    const pageIndex = (textBefore.match(/\f/g) || []).length;

    return { sentence, pageIndex };
  },

  similarity(s1, s2) {
    // Character-level similarity using longest common substring ratio
    const lcs = this.longestCommonSubstring(s1, s2);
    return (2 * lcs.length) / (s1.length + s2.length);
  },

  longestCommonSubstring(s1, s2) {
    if (!s1 || !s2) return "";
    let maxLen = 0;
    let endIndex = 0;
    const matrix = Array(s1.length + 1).fill(null).map(() => Array(s2.length + 1).fill(0));

    for (let i = 1; i <= s1.length; i++) {
      for (let j = 1; j <= s2.length; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1] + 1;
          if (matrix[i][j] > maxLen) {
            maxLen = matrix[i][j];
            endIndex = i;
          }
        }
      }
    }

    return s1.substring(endIndex - maxLen, endIndex);
  },

  async matchQuoteInPDF(pdfPath, quoteCandidate, pageHint) {
    const pythonPath = this.getPythonPath();
    const helperPath = this.getHelperScriptPath();

    const tmpFile = Zotero.getTempDirectory();
    tmpFile.append("zva_match.json");
    tmpFile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o666);

    const args = [helperPath, "match", "--pdf", pdfPath, "--quote", quoteCandidate, "--output", tmpFile.path];
    if (pageHint !== undefined && pageHint !== null) {
      args.push("--page-hint", String(pageHint));
    }

    this.log("debug", "Matching quote:", quoteCandidate);
    await this.runCommand(pythonPath, args);

    const output = await Zotero.File.getContentsAsync(tmpFile);
    tmpFile.remove(false);

    try {
      const json = JSON.parse(output);
      this.log("debug", "Match result:", json);
      if (json.found) {
        return {
          sentence: json.sentence,
          pageIndex: json.pageIndex,
          pageLabel: json.pageLabel || String(json.pageIndex + 1),
          rects: json.rects,
          commentary: json.commentary || ""
        };
      }
      return null;
    } catch (e) {
      this.log("error", "Failed to parse match result:", e);
      return null;
    }
  },

  async locateTextInPDF(pdfPath, text, pageHint) {
    const pythonPath = this.getPythonPath();
    const helperPath = this.getHelperScriptPath();

    const tmpFile = Zotero.getTempDirectory();
    tmpFile.append("zva_locate.json");
    tmpFile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o666);

    const args = [helperPath, "locate", "--pdf", pdfPath, "--text", text, "--output", tmpFile.path];
    if (pageHint !== undefined && pageHint !== null) {
      args.push("--page-hint", String(pageHint));
    }

    await this.runCommand(pythonPath, args);

    const output = await Zotero.File.getContentsAsync(tmpFile);
    tmpFile.remove(false);

    try {
      const json = JSON.parse(output);
      if (json.found) {
        return {
          pageIndex: json.pageIndex,
          rects: json.rects,
          pageLabel: json.pageLabel || String(json.pageIndex + 1)
        };
      }
      return null;
    } catch {
      return null;
    }
  },

  async findExistingAnnotation(pdfItem, text, position) {
    const annotations = pdfItem.getAnnotations();
    for (const ann of annotations) {
      if (ann.annotationType !== "highlight") continue;
      const annText = ann.annotationText || "";
      // Normalize for comparison
      if (this.normalizeText(annText) === this.normalizeText(text)) {
        // Also check position similarity
        try {
          const annPos = JSON.parse(ann.annotationPosition || "{}");
          if (annPos.pageIndex === position.pageIndex) {
            return ann;
          }
        } catch {
          // If position parsing fails, fall back to text-only
          return ann;
        }
      }
    }
    return null;
  },

  async appendCommentaryToAnnotation(annotation, commentary) {
    if (!commentary) return;
    try {
      const existingComment = annotation.annotationComment || "";
      const normalizedExisting = this.normalizeText(existingComment);
      const normalizedNew = this.normalizeText(commentary);

      // Avoid appending identical or already-present commentary
      if (normalizedExisting === normalizedNew || normalizedExisting.endsWith(normalizedNew)) {
        this.log("info", "Commentary already present on annotation; skipping append");
        return;
      }

      const separator = existingComment ? "\n\n" : "";
      annotation.annotationComment = existingComment + separator + commentary;
      await annotation.saveTx();
    } catch (err) {
      this.log("error", "Failed to append commentary to annotation:", err);
      throw err;
    }
  },

  normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  },

  expandQuoteToSpokenWords(segment, match) {
    // If we don't have the original spoken words, nothing to expand
    if (!segment.words || segment.words.length === 0 || !segment.matchedCount) {
      return { quoteCandidate: segment.quoteCandidate, commentary: segment.commentary };
    }

    // Only expand longer initial matches. Short matches (e.g., 1-3 word titles)
    // are likely complete quotes on their own; expanding them often pulls in
    // the next sentence when the title lacks ending punctuation.
    if (segment.matchedCount < 4) {
      return { quoteCandidate: segment.quoteCandidate, commentary: segment.commentary };
    }

    const sentence = match.sentence || "";
    if (!sentence) return { quoteCandidate: segment.quoteCandidate, commentary: segment.commentary };

    // Build normalized sentence word list
    const sentenceWords = sentence.split(/\s+/)
      .map(w => this.normalizeWord(w))
      .filter(w => w.length > 0);

    // Starting from the initial match, keep expanding while the next spoken word
    // is also the next expected word in the sentence.
    let expandedCount = segment.matchedCount;
    let sentenceIndex = 0;

    // Find where the initial matched quote starts in the sentence
    const initialQuoteWords = segment.words.slice(0, segment.matchedCount).map(w => w.normalized || this.normalizeWord(w.word));
    for (let i = 0; i <= sentenceWords.length - initialQuoteWords.length; i++) {
      let found = true;
      for (let j = 0; j < initialQuoteWords.length; j++) {
        if (sentenceWords[i + j] !== initialQuoteWords[j]) {
          found = false;
          break;
        }
      }
      if (found) {
        sentenceIndex = i + initialQuoteWords.length;
        break;
      }
    }

    // Expand as long as the next spoken word matches the next sentence word
    while (expandedCount < segment.words.length && sentenceIndex < sentenceWords.length) {
      const nextSpoken = segment.words[expandedCount].normalized || this.normalizeWord(segment.words[expandedCount].word);
      if (nextSpoken === sentenceWords[sentenceIndex]) {
        expandedCount++;
        sentenceIndex++;
      } else {
        break;
      }
    }

    const quoteWords = segment.words.slice(0, expandedCount);
    const commentaryWords = segment.words.slice(expandedCount);

    return {
      quoteCandidate: quoteWords.map(w => w.word).join(" "),
      commentary: commentaryWords.map(w => w.word).join(" ")
    };
  },

  async createHighlightAnnotation(pdfItem, text, comment, position, color) {
    // Build sortIndex: pageIndex | textOffset | yFromTop
    const pageIndex = position.pageIndex;
    const yFromTop = Math.max(0, Math.floor(position.rects[0][3] || 0));
    const sortIndex = `${String(pageIndex).padStart(5, "0")}|${String(0).padStart(6, "0")}|${String(yFromTop).padStart(5, "0")}`;

    let key;
    try {
      key = Zotero.DataObjectUtilities.generateKey();
    } catch (e) {
      this.log("error", "Failed to generate annotation key:", e);
      throw new Error("Could not generate annotation key: " + e.message);
    }

    const json = {
      type: "highlight",
      key: key,
      text: text,
      comment: comment || "",
      color: color,
      pageLabel: position.pageLabel || String(pageIndex + 1),
      sortIndex: sortIndex,
      position: {
        pageIndex: pageIndex,
        rects: position.rects
      }
    };

    this.log("debug", "Creating annotation:", JSON.stringify(json));

    try {
      let annotation;
      if (Zotero.Notifier && Zotero.Notifier.Queue) {
        const queue = new Zotero.Notifier.Queue();
        annotation = await Zotero.Annotations.saveFromJSON(pdfItem, json, { notifierQueue: queue });
        await Zotero.Notifier.commit(queue);
      } else {
        annotation = await Zotero.Annotations.saveFromJSON(pdfItem, json);
      }
      this.log("info", "Created annotation:", annotation?.key || annotation?.id || "unknown");
      return annotation;
    } catch (err) {
      this.log("error", "Failed to create annotation:", err);
      throw err;
    }
  }
};

Zotero.VoiceAnnotator = VoiceAnnotator;
