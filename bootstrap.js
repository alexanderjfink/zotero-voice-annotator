// Bootstrap entry point for Zotero Voice Annotator plugin

var chromeHandle = null;

async function startup({ id, version, resourceURI, rootURI }) {
  await Zotero.initializationPromise;

  // Register chrome:// URLs for bundled resources
  try {
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zva", "chrome/content/"]
    ]);
  } catch (e) {
    Zotero.debug("[ZoteroVoiceAnnotator] Chrome registration failed: " + e.message);
  }

  // Load main module into a scope with required globals
  const scriptURI = rootURI + "modules/zotero-voice-annotator.js";
  Services.scriptloader.loadSubScript(scriptURI, {
    Zotero,
    Components,
    Services,
    window: undefined
  });

  // Initialize plugin
  if (typeof Zotero.VoiceAnnotator !== "undefined") {
    await Zotero.VoiceAnnotator.init({ id, version, rootURI });
  }

  // Register window hooks for existing windows
  Zotero.getMainWindows().forEach((win) => {
    if (typeof Zotero.VoiceAnnotator !== "undefined") {
      Zotero.VoiceAnnotator.onMainWindowLoad({ window: win });
    }
  });

  // Watch for new windows
  Services.wm.addListener({
    onOpenWindow: (xulWin) => {
      const domWin = xulWin.docShell.domWindow;
      domWin.addEventListener("load", () => {
        if (typeof Zotero.VoiceAnnotator !== "undefined" && domWin.location?.href?.includes("zoteroPane.xhtml")) {
          Zotero.VoiceAnnotator.onMainWindowLoad({ window: domWin });
        }
      }, { once: true });
    },
    onCloseWindow: (xulWin) => {
      const domWin = xulWin.docShell.domWindow;
      if (typeof Zotero.VoiceAnnotator !== "undefined" && domWin.location?.href?.includes("zoteroPane.xhtml")) {
        Zotero.VoiceAnnotator.onMainWindowUnload({ window: domWin });
      }
    },
    onWindowTitleChange: () => {}
  });
}

function shutdown({ id, version, resourceURI, rootURI }) {
  if (typeof Zotero.VoiceAnnotator !== "undefined") {
    Zotero.VoiceAnnotator.shutdown();
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function install() {}
function uninstall() {}
