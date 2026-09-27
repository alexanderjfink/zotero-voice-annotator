"use strict";

// Marginal Voice Preferences Pane Script
// Loaded via PreferencePanes.register({ scripts: [...] }).
// Public functions are exposed on window.MVPrefs for XUL oncommand handlers.

(function () {
  const PREF = "extensions.marginalvoice.";
  const P  = (k, fallback) => {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && Zotero.Prefs.get) {
        return Zotero.Prefs.get(PREF + k, true);
      }
    } catch (e) {
      dump("[MarginalVoicePrefs] get failed: " + e + "\n");
    }
    return fallback;
  };
  const SP = (k, v) => {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && Zotero.Prefs.set) {
        Zotero.Prefs.set(PREF + k, v, true);
      }
    } catch (e) {
      dump("[MarginalVoicePrefs] set failed: " + e + "\n");
    }
  };

  function mvLog(msg) {
    dump("[MarginalVoicePrefs] " + msg + "\n");
    try {
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug("[MarginalVoicePrefs] " + msg);
      }
    } catch (_) {}
  }

  const COLORS = [
    { name: "Yellow", value: "#ffd400" },
    { name: "Red", value: "#ff6666" },
    { name: "Green", value: "#5fb236" },
    { name: "Blue", value: "#2ea8e5" },
    { name: "Purple", value: "#a28ae5" },
    { name: "Orange", value: "#f19837" }
  ];

  const DEFAULT_TRIGGERS = [
    { phrase: "quote", color: "#ffd400" },
    { phrase: "Main Theory", color: "#2ea8e5" },
    { phrase: "Key Point", color: "#ff6666" },
    { phrase: "Definition", color: "#5fb236" }
  ];

  function getTriggers() {
    try {
      const raw = P("triggers", "");
      if (!raw) return DEFAULT_TRIGGERS.map(t => ({ ...t }));
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      return DEFAULT_TRIGGERS.map(t => ({ ...t }));
    } catch (e) {
      mvLog("getTriggers error: " + e);
      return DEFAULT_TRIGGERS.map(t => ({ ...t }));
    }
  }

  function saveTriggers(triggers) {
    SP("triggers", JSON.stringify(triggers));
  }

  function createColorMenulist(selectedValue) {
    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    const menulist = document.createElementNS(XUL, "menulist");
    const popup = document.createElementNS(XUL, "menupopup");
    for (const c of COLORS) {
      const item = document.createElementNS(XUL, "menuitem");
      item.setAttribute("value", c.value);
      item.setAttribute("label", c.name);
      popup.appendChild(item);
    }
    menulist.appendChild(popup);
    menulist.setAttribute("value", selectedValue || COLORS[0].value);
    menulist.addEventListener("command", saveAllPrefs);
    return menulist;
  }

  function createTriggerRow(trigger) {
    trigger = trigger || { phrase: "", color: COLORS[0].value };
    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    const HTML = "http://www.w3.org/1999/xhtml";

    const row = document.createElementNS(XUL, "hbox");
    row.setAttribute("class", "mv-trigger-row");
    row.setAttribute("align", "center");

    const input = document.createElementNS(HTML, "input");
    input.setAttribute("type", "text");
    input.setAttribute("placeholder", "Trigger phrase");
    input.value = trigger.phrase || "";
    input.addEventListener("change", saveAllPrefs);
    input.setAttribute("style", "width: 180px;");
    row.appendChild(input);

    const colorList = createColorMenulist(trigger.color);
    colorList.setAttribute("style", "width: 120px; margin-left: 8px;");
    row.appendChild(colorList);

    const removeBtn = document.createElementNS(XUL, "button");
    removeBtn.setAttribute("label", "−");
    removeBtn.setAttribute("style", "margin-left: 8px; min-width: 28px;");
    removeBtn.addEventListener("command", function() {
      if (row.parentNode) row.parentNode.removeChild(row);
      saveAllPrefs();
    });
    row.appendChild(removeBtn);

    return row;
  }

  function renderTriggers() {
    const container = document.getElementById("marginalvoice-triggers-list");
    if (!container) return;
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    const triggers = getTriggers();
    mvLog("renderTriggers: " + triggers.length + " triggers");
    for (const t of triggers) {
      container.appendChild(createTriggerRow(t));
    }
  }

  function collectTriggers() {
    const container = document.getElementById("marginalvoice-triggers-list");
    const triggers = [];
    for (const row of container.children) {
      const input = row.querySelector("input");
      const colorList = row.querySelector("menulist");
      const phrase = (input ? input.value : "").trim();
      if (phrase) {
        triggers.push({ phrase, color: colorList ? colorList.value : COLORS[0].value });
      }
    }
    return triggers;
  }

  function addTriggerRow() {
    const container = document.getElementById("marginalvoice-triggers-list");
    if (!container) return;
    const row = createTriggerRow();
    container.appendChild(row);
    const input = row.querySelector("input");
    if (input) input.focus();
  }

  function resetDefaults() {
    const timeoutInput = document.getElementById("marginalvoice-silenceTimeout");
    if (timeoutInput) timeoutInput.value = 5;
    saveTriggers(DEFAULT_TRIGGERS.map(t => ({ ...t })));
    renderTriggers();
  }

  function captureShortcut(input) {
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Ignore bare modifier presses
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
      const mods = [];
      if (e.metaKey || e.ctrlKey) mods.push("CmdOrCtrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      const key = e.key === " " ? "Space" : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const combo = [...mods, key].join("+");
      input.value = combo;
      SP("liveShortcut", combo);
      saveAllPrefs();
    });
    input.addEventListener("click", () => {
      input.select();
    });
  }

  function saveAllPrefs() {
    mvLog("saveAllPrefs called");
    try {
      SP("transcriptionMode", document.getElementById("marginalvoice-transcriptionMode").value);
      SP("pythonPath", document.getElementById("marginalvoice-pythonPath").value);
      SP("helperScriptPath", document.getElementById("marginalvoice-helperScriptPath").value);
      SP("customCommandPath", document.getElementById("marginalvoice-customCommandPath").value);
      SP("customCommandArgs", document.getElementById("marginalvoice-customCommandArgs").value);
      SP("whisperModel", document.getElementById("marginalvoice-whisperModel").value);
      SP("silenceTimeout", parseInt(document.getElementById("marginalvoice-silenceTimeout").value, 10) || 5);
      SP("skipDuplicates", document.getElementById("marginalvoice-skipDuplicates").checked);
      SP("logLevel", document.getElementById("marginalvoice-logLevel").value);
      SP("liveMode", document.getElementById("marginalvoice-liveMode").value);
      SP("liveShortcut", document.getElementById("marginalvoice-liveShortcut").value);
      SP("liveFlushInterval", parseInt(document.getElementById("marginalvoice-liveFlushInterval").value, 10) || 2);
      SP("liveShowOverlay", document.getElementById("marginalvoice-liveShowOverlay").checked);
      saveTriggers(collectTriggers());
      mvLog("saveAllPrefs done");
    } catch (e) {
      mvLog("saveAllPrefs error: " + e);
    }
  }

  function init() {
    mvLog("init called");
    try {
      document.getElementById("marginalvoice-transcriptionMode").value = P("transcriptionMode", "python");
      document.getElementById("marginalvoice-pythonPath").value = P("pythonPath", "");
      document.getElementById("marginalvoice-helperScriptPath").value = P("helperScriptPath", "");
      document.getElementById("marginalvoice-customCommandPath").value = P("customCommandPath", "");
      document.getElementById("marginalvoice-customCommandArgs").value = P("customCommandArgs", "");
      document.getElementById("marginalvoice-whisperModel").value = P("whisperModel", "base");
      document.getElementById("marginalvoice-silenceTimeout").value = P("silenceTimeout", 5);
      document.getElementById("marginalvoice-skipDuplicates").checked = P("skipDuplicates", true);
      document.getElementById("marginalvoice-logLevel").value = P("logLevel", "info");
      document.getElementById("marginalvoice-liveMode").value = P("liveMode", "toggle");
      document.getElementById("marginalvoice-liveShortcut").value = P("liveShortcut", "CmdOrCtrl+Shift+V");
      document.getElementById("marginalvoice-liveFlushInterval").value = P("liveFlushInterval", 2);
      document.getElementById("marginalvoice-liveShowOverlay").checked = P("liveShowOverlay", true) !== false;
      captureShortcut(document.getElementById("marginalvoice-liveShortcut"));
      renderTriggers();
      mvLog("init done");
    } catch (e) {
      mvLog("init error: " + e);
    }
  }

  function onPaneLoad(e) {
    if (e.target && e.target.id === "marginalvoice-preferences") {
      document.removeEventListener("load", onPaneLoad, true);
      init();
    }
  }

  window.MVPrefs = {
    addTriggerRow,
    resetDefaults,
    saveAllPrefs
  };

  document.addEventListener("load", onPaneLoad, true);
  mvLog("preferences.js loaded");
}());
