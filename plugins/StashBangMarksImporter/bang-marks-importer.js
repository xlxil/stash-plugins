(function () {
  "use strict";

  const PLUGIN_ID = "bang-marks-importer";
  const PLUGIN_NAME = "Bang Marks Importer";
  const SCENE_BUTTON_ID = "bmi-import-bang-marks-btn";
  const BULK_BUTTON_ID = "bmi-bulk-import-bang-marks-btn";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error(`[${PLUGIN_NAME}] PluginApi is not available.`);
    return;
  }

  const React = PluginApi.React;
  if (!React) {
    console.error(`[${PLUGIN_NAME}] React is not available.`);
    return;
  }

  const { useEffect } = React;
  let ToastApi = null;

  function setToastApi(api) {
    ToastApi = api || null;
  }

  function notify(message, type = "info") {
    const text = String(message || "");

    try {
      if (!ToastApi) {
        console[type === "error" ? "error" : "log"](`[${PLUGIN_NAME}] ${text}`);
        return;
      }

      if (type === "error") {
        if (typeof ToastApi.error === "function") {
          ToastApi.error(text);
          return;
        }
        if (typeof ToastApi.toast === "function") {
          ToastApi.toast({ content: text, variant: "danger", priority: 100, delay: 7000 });
          return;
        }
      }

      if (type === "warning" && typeof ToastApi.toast === "function") {
        ToastApi.toast({ content: text, variant: "warning", priority: 20, delay: 7000 });
        return;
      }

      if (type === "success") {
        if (typeof ToastApi.success === "function") {
          ToastApi.success(text);
          return;
        }
        if (typeof ToastApi.toast === "function") {
          ToastApi.toast({ content: text, variant: "success", delay: 5000 });
          return;
        }
      }

      if (typeof ToastApi.toast === "function") {
        ToastApi.toast({ content: text, delay: 5000 });
        return;
      }

      if (typeof ToastApi.success === "function") {
        ToastApi.success(text);
        return;
      }

      console.log(`[${PLUGIN_NAME}] ${text}`);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] Failed to show Stash toast:`, error);
      console.log(`[${PLUGIN_NAME}] ${text}`);
    }
  }

  function getSceneIdFromPath() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function isSceneListPath() {
    const path = window.location.pathname;
    return path === "/scenes" || path === "/scenes/";
  }

  async function graphql(query, variables = {}) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    if (!body) {
      throw new Error("GraphQL returned an empty response.");
    }
    if (body.errors && body.errors.length) {
      throw new Error(body.errors.map((error) => error.message).join("; "));
    }

    return body.data;
  }

  function parseMaybeJson(value) {
    if (!value) return value;
    if (typeof value !== "string") return value;

    try {
      return JSON.parse(value);
    } catch (_) {
      return { status: "raw_output", message: value };
    }
  }

  function unwrapPluginResult(rawResult) {
    if (!rawResult) {
      return { status: "error", message: "Plugin returned an empty result." };
    }

    rawResult = parseMaybeJson(rawResult);

    if (rawResult.error) {
      const parsedOutput = parseMaybeJson(rawResult.output || rawResult.result || null);
      return {
        status: parsedOutput && parsedOutput.status ? parsedOutput.status : "error",
        message: rawResult.error,
        details: parsedOutput,
      };
    }

    const payload = parseMaybeJson(rawResult.output || rawResult.Output || rawResult.result || rawResult);
    return payload || { status: "error", message: "Plugin returned an empty result." };
  }

  async function runImportWithArgs(args) {
    const mutation = `
      mutation RunBangChaptersImporter($args: Map) {
        runPluginOperation(plugin_id: "${PLUGIN_ID}", args: $args)
      }
    `;

    const data = await graphql(mutation, { args });
    return unwrapPluginResult(data.runPluginOperation);
  }

  function formatSingleResultMessage(result) {
    const status = result.status || "unknown";

    if (status === "success") {
      const lowConfidence = result.low_confidence_count || 0;
      if (lowConfidence > 0) {
        return {
          type: "warning",
          message: `Bang marks imported: created ${result.created_count || 0}, low-confidence tag matches ${lowConfidence}, duplicates skipped ${result.skipped_duplicates || 0}.`,
        };
      }
      return {
        type: "success",
        message: `Bang marks imported: created ${result.created_count || 0}, duplicates skipped ${result.skipped_duplicates || 0}.`,
      };
    }

    if (status === "partial_success") {
      return {
        type: "warning",
        message: `Import partially completed: created ${result.created_count || 0}, errors ${result.error_count || 0}, low-confidence chapters skipped ${result.skipped_low_confidence_count || 0}.`,
      };
    }

    if (status === "all_duplicates") return { type: "info", message: `Bang markers already seem to exist. Duplicates skipped: ${result.skipped_duplicates || 0}.` };
    if (status === "no_bang_url") return { type: "warning", message: "This scene does not have a Bang.com video URL." };
    if (status === "no_bang_video_page_url") return { type: "warning", message: "This scene has a Bang.com URL, but it is not a /video/<id>/<slug> page URL." };
    if (status === "no_internal_video_id") return { type: "warning", message: "The Bang.com page was loaded, but no internal video ID was found for the chapters endpoint." };
    if (status === "no_chapters") return { type: "warning", message: "The Bang.com chapters endpoint returned no WEBVTT cues." };
    if (status === "invalid_vtt") return { type: "warning", message: "The Bang.com chapters endpoint responded, but the response does not look like WEBVTT." };
    if (status === "no_tags") return { type: "warning", message: "No Stash tags exist. Scene markers cannot be created without an existing primary tag." };
    if (status === "raw_output") return { type: "info", message: result.message || "Plugin returned raw output." };

    return { type: "error", message: result.message || "Bang mark import failed. Check the browser console and Stash logs." };
  }

  function formatBulkResultMessage(result) {
    if (result.status === "bulk_completed") {
      const problems = (result.failed_count || 0) + (result.skipped_count || 0) + (result.low_confidence_total || 0);
      return {
        type: problems > 0 ? "warning" : "success",
        message: `Bulk Bang marks import finished: scenes ${result.total || 0}, created markers ${result.created_total || 0}, duplicate markers skipped ${result.duplicate_total || 0}, skipped scenes ${result.skipped_count || 0}, failed scenes ${result.failed_count || 0}.`,
      };
    }

    if (result.status === "bulk_empty") {
      return { type: "warning", message: "No scenes were selected for bulk import." };
    }

    return formatSingleResultMessage(result);
  }

  function createSceneButton(sceneId) {
    const button = document.createElement("button");
    button.id = SCENE_BUTTON_ID;
    button.type = "button";
    button.className = "minimal bmi-import-bang-marks-btn btn btn-secondary";
    button.title = "Import Bang.com marks as markers";
    button.setAttribute("aria-label", "Import Bang.com marks");
    button.dataset.sceneId = sceneId;

    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 19V5"></path>
        <path d="M8 7h9l-2 4 2 4H8"></path>
        <path d="M8 19V7"></path>
      </svg>
    `;

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentSceneId = button.dataset.sceneId || getSceneIdFromPath();
      if (!currentSceneId) {
        notify("Could not determine the current scene ID.", "error");
        return;
      }

      button.disabled = true;
      button.classList.add("bci-loading");
      notify("Loading Bang.com page and chapters...", "info");

      try {
        const result = await runImportWithArgs({ scene_id: currentSceneId });
        const formatted = formatSingleResultMessage(result);
        notify(formatted.message, formatted.type);
        console.log(`[${PLUGIN_NAME}] Result:`, result);
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] Import failed:`, error);
        notify(`Import failed: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.classList.remove("bci-loading");
      }
    });

    return button;
  }

  function extractSceneIdsFromElement(element, targetSet) {
    if (!element) return;

    const dataCandidates = [
      element.getAttribute && element.getAttribute("data-id"),
      element.getAttribute && element.getAttribute("data-scene-id"),
      element.value,
    ];

    for (const candidate of dataCandidates) {
      if (candidate && /^\d+$/.test(String(candidate))) {
        targetSet.add(String(candidate));
      }
    }

    const anchors = element.querySelectorAll ? element.querySelectorAll('a[href*="/scenes/"]') : [];
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/scenes\/(\d+)/);
      if (match) targetSet.add(match[1]);
    }
  }

  function getSelectedSceneIdsFromDom() {
    const ids = new Set();

    const checkedInputs = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((input) => input.checked && !input.disabled);
    for (const input of checkedInputs) {
      extractSceneIdsFromElement(input, ids);
      const container = input.closest('tr, .scene-card, .grid-card, .card, .wall-item, [class*="Scene"], [class*="scene"]');
      extractSceneIdsFromElement(container, ids);
    }

    const selectedElements = document.querySelectorAll('.selected, .active.selected, [aria-selected="true"], [data-selected="true"]');
    for (const element of selectedElements) {
      extractSceneIdsFromElement(element, ids);
    }

    return Array.from(ids);
  }

  function createBulkButton() {
    const button = document.createElement("button");
    button.id = BULK_BUTTON_ID;
    button.type = "button";
    button.className = "bmi-bulk-import-bang-marks-btn btn btn-secondary";
    button.title = "Import Bang.com marks for selected scenes";
    button.textContent = "Bang marks";

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const selectedSceneIds = getSelectedSceneIdsFromDom();
      if (!selectedSceneIds.length) {
        notify("No selected scenes found. Select scenes in the scene grid/list first.", "warning");
        return;
      }

      const confirmed = window.confirm(`Import Bang.com marks for ${selectedSceneIds.length} selected scene(s)?`);
      if (!confirmed) return;

      button.disabled = true;
      button.classList.add("bci-loading");
      notify(`Starting bulk Bang marks import for ${selectedSceneIds.length} scene(s)...`, "info");

      try {
        const result = await runImportWithArgs({ scene_ids: selectedSceneIds });
        const formatted = formatBulkResultMessage(result);
        notify(formatted.message, formatted.type);
        console.log(`[${PLUGIN_NAME}] Bulk result:`, result);
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] Bulk import failed:`, error);
        notify(`Bulk import failed: ${error.message}`, "error");
      } finally {
        button.disabled = false;
        button.classList.remove("bci-loading");
      }
    });

    return button;
  }

  function removeSceneButton() {
    const existingButton = document.getElementById(SCENE_BUTTON_ID);
    if (existingButton) existingButton.remove();
  }

  function removeBulkButton() {
    const existingButton = document.getElementById(BULK_BUTTON_ID);
    if (existingButton) existingButton.remove();
  }

  function injectSceneButton() {
    const sceneId = getSceneIdFromPath();
    if (!sceneId) {
      removeSceneButton();
      return;
    }

    const toolbar = document.querySelector(".scene-toolbar");
    if (!toolbar) return;

    let button = document.getElementById(SCENE_BUTTON_ID);
    if (!button) {
      button = createSceneButton(sceneId);
      const operationMenu = toolbar.querySelector("#operation-menu");
      const operationMenuWrapper = operationMenu ? operationMenu.closest("span") : null;

      if (operationMenuWrapper && operationMenuWrapper.parentElement) {
        operationMenuWrapper.parentElement.insertBefore(button, operationMenuWrapper.nextSibling);
      } else {
        toolbar.appendChild(button);
      }
      return;
    }

    button.dataset.sceneId = sceneId;
    if (!toolbar.contains(button)) toolbar.appendChild(button);
  }

  function findFilteredListToolbar() {
    return (
      document.querySelector(".filtered-list-toolbar.btn-toolbar") ||
      document.querySelector(".filtered-list-toolbar")
    );
  }

  function findBulkButtonTarget(toolbar) {
    if (!toolbar) {
      return null;
    }

    return (
      toolbar.querySelector(".list-operations > .btn-group") ||
      toolbar.querySelector(".list-operations .btn-group") ||
      toolbar.querySelector(".list-operations") ||
      toolbar
    );
  }

  function injectBulkButton() {
    if (!isSceneListPath()) {
      removeBulkButton();
      return;
    }

    const toolbar = findFilteredListToolbar();
    if (!toolbar) {
      return;
    }

    const target = findBulkButtonTarget(toolbar);
    if (!target) {
      return;
    }

    let button = document.getElementById(BULK_BUTTON_ID);
    if (!button) {
      button = createBulkButton();
    }

    if (!target.contains(button)) {
      const moreMenu = target.querySelector("#more-menu");
      const moreMenuWrapper = moreMenu ? moreMenu.closest(".dropdown, .btn-group, button") : null;

      if (moreMenuWrapper && moreMenuWrapper.parentElement === target) {
        moreMenuWrapper.insertAdjacentElement("afterend", button);
      } else {
        target.appendChild(button);
      }
    }
  }

  function BangChaptersInjector() {
    let Toast = null;

    try {
      if (PluginApi.hooks && typeof PluginApi.hooks.useToast === "function") {
        Toast = PluginApi.hooks.useToast();
      }
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] Failed to initialize Stash toast API:`, error);
    }

    useEffect(() => {
      setToastApi(Toast);
      return () => setToastApi(null);
    }, [Toast]);

    useEffect(() => {
      let disposed = false;

      const safeInject = () => {
        if (disposed) return;
        try {
          injectSceneButton();
          injectBulkButton();
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] Injection failed:`, error);
        }
      };

      safeInject();

      const observer = new MutationObserver(safeInject);
      observer.observe(document.body, { childList: true, subtree: true });

      const onLocationChange = () => window.setTimeout(safeInject, 0);
      if (PluginApi.Event && PluginApi.Event.addEventListener) {
        PluginApi.Event.addEventListener("stash:location", onLocationChange);
      }

      return () => {
        disposed = true;
        observer.disconnect();
        if (PluginApi.Event && PluginApi.Event.removeEventListener) {
          PluginApi.Event.removeEventListener("stash:location", onLocationChange);
        }
        removeSceneButton();
        removeBulkButton();
      };
    }, []);

    return null;
  }

  try {
    if (!PluginApi.patch || !PluginApi.patch.after) {
      console.error(`[${PLUGIN_NAME}] PluginApi.patch.after is not available.`);
      return;
    }

    PluginApi.patch.after("ScenePage", function (...args) {
      const result = args[args.length - 1];
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(BangChaptersInjector, { key: "bang-chapters-injector-scene-page" })
      );
    });

    PluginApi.patch.after("FilteredSceneList", function (...args) {
      const result = args[args.length - 1];
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(BangChaptersInjector, { key: "bang-chapters-injector-filtered-scene-list" })
      );
    });

    console.log(`[${PLUGIN_NAME}] Registered ScenePage and FilteredSceneList patches with toolbar bulk button.`);
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] Failed to register patches:`, error);
  }
})();
