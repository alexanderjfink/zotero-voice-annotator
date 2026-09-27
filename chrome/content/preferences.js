"use strict";

// Zotero Voice Annotator Preferences Pane Script
// Loaded via PreferencePanes.register({ scripts: [...] }).
// Public functions are exposed on window.ZVAPrefs for XUL oncommand handlers.

(function () {
  const PREF = "extensions.zotero-voice-annotator.";
  const P  = (k, fallback) => {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && Zotero.Prefs.get) {
        return Zotero.Prefs.get(PREF + k, true);
      }
    } catch (e) {
      dump("[ZoteroVoiceAnnotatorPrefs] get failed: " + e + "\n");
    }
    return fallback;
  };
  const SP = (k, v) => {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && Zotero.Prefs.set) {
        Zotero.Prefs.set(PREF + k, v, true);
      }
    } catch (e) {
      dump("[ZoteroVoiceAnnotatorPrefs] set failed: " + e + "\n");
    }
  };

  function mvLog(msg) {
    dump("[ZoteroVoiceAnnotatorPrefs] " + msg + "\n");
    try {
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug("[ZoteroVoiceAnnotatorPrefs] " + msg);
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
    { phrase: "Highlight", color: "#ffd400" },
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
    const container = document.getElementById("zva-triggers-list");
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
    const container = document.getElementById("zva-triggers-list");
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
    const container = document.getElementById("zva-triggers-list");
    if (!container) return;
    const row = createTriggerRow();
    container.appendChild(row);
    const input = row.querySelector("input");
    if (input) input.focus();
  }

  function resetDefaults() {
    const timeoutInput = document.getElementById("zva-silenceTimeout");
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
      SP("transcriptionMode", document.getElementById("zva-transcriptionMode").value);
      SP("pythonPath", document.getElementById("zva-pythonPath").value);
      SP("helperScriptPath", document.getElementById("zva-helperScriptPath").value);
      SP("customCommandPath", document.getElementById("zva-customCommandPath").value);
      SP("customCommandArgs", document.getElementById("zva-customCommandArgs").value);
      SP("whisperModel", document.getElementById("zva-whisperModel").value);
      SP("silenceTimeout", parseInt(document.getElementById("zva-silenceTimeout").value, 10) || 5);
      SP("skipDuplicates", document.getElementById("zva-skipDuplicates").checked);
      SP("logLevel", document.getElementById("zva-logLevel").value);
      SP("liveMode", document.getElementById("zva-liveMode").value);
      SP("liveShortcut", document.getElementById("zva-liveShortcut").value);
      SP("liveFlushInterval", parseInt(document.getElementById("zva-liveFlushInterval").value, 10) || 2);
      SP("liveShowOverlay", document.getElementById("zva-liveShowOverlay").checked);
      saveTriggers(collectTriggers());
      mvLog("saveAllPrefs done");
    } catch (e) {
      mvLog("saveAllPrefs error: " + e);
    }
  }

  function init() {
    mvLog("init called");
    try {
      document.getElementById("zva-transcriptionMode").value = P("transcriptionMode", "python");
      document.getElementById("zva-pythonPath").value = P("pythonPath", "");
      document.getElementById("zva-helperScriptPath").value = P("helperScriptPath", "");
      document.getElementById("zva-customCommandPath").value = P("customCommandPath", "");
      document.getElementById("zva-customCommandArgs").value = P("customCommandArgs", "");
      document.getElementById("zva-whisperModel").value = P("whisperModel", "base");
      document.getElementById("zva-silenceTimeout").value = P("silenceTimeout", 5);
      document.getElementById("zva-skipDuplicates").checked = P("skipDuplicates", true);
      document.getElementById("zva-logLevel").value = P("logLevel", "info");
      document.getElementById("zva-liveMode").value = P("liveMode", "toggle");
      document.getElementById("zva-liveShortcut").value = P("liveShortcut", "CmdOrCtrl+Shift+V");
      document.getElementById("zva-liveFlushInterval").value = P("liveFlushInterval", 2);
      document.getElementById("zva-liveShowOverlay").checked = P("liveShowOverlay", true) !== false;
      captureShortcut(document.getElementById("zva-liveShortcut"));
      renderTriggers();
      mvLog("init done");
    } catch (e) {
      mvLog("init error: " + e);
    }
  }

  function onPaneLoad(e) {
    if (e.target && e.target.id === "zva-preferences") {
      document.removeEventListener("load", onPaneLoad, true);
      init();
    }
  }

  window.ZVAPrefs = {
    addTriggerRow,
    resetDefaults,
    saveAllPrefs
  };

  document.addEventListener("load", onPaneLoad, true);
  mvLog("preferences.js loaded");
}());
