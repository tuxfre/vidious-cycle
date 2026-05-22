// ==UserScript==
// @name         Vidious Cycle
// @namespace    xyz.vigier.userscripts.vidious-cycle
// @version      0.1.1
// @description  Redirect YouTube video URLs to a user-selected online Invidious instance.
// @author       tuxfre
// @license      MIT
// @homepageURL  https://github.com/tuxfre/vidious-cycle
// @supportURL   https://github.com/tuxfre/vidious-cycle/issues
// @updateURL    https://raw.githubusercontent.com/tuxfre/vidious-cycle/main/vidious-cycle.user.js
// @downloadURL  https://raw.githubusercontent.com/tuxfre/vidious-cycle/main/vidious-cycle.user.js
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      api.invidious.io
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = {
        debug: true,

        instanceApiUrl:
            "https://api.invidious.io/instances.json?pretty=1&sort_by=type,users",

        selectedInstanceKey: "vidiousCycle.selectedInstance",
        instanceCacheKey: "vidiousCycle.instanceCache",

        instanceCacheTtlMs: 30 * 60 * 1000,
        minimumUptimePercent: 90,
    };

    let lastHandledHref = null;
    let currentHandleToken = 0;

    installStyles();
    registerMenuCommands();
    installYouTubeNavigationWatcher();
    scheduleCurrentLocationHandling("initial load");

    function installStyles() {
        GM_addStyle(`
      #vidious-cycle-picker {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        padding: 16px;
        background: rgba(0, 0, 0, 0.72);
        color: #111;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #vidious-cycle-picker * {
        box-sizing: border-box;
      }

      #vidious-cycle-picker .vidious-cycle-card {
        width: min(760px, 100%);
        padding: 24px;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 22px 72px rgba(0, 0, 0, 0.36);
      }

      #vidious-cycle-picker h1 {
        margin: 0 0 8px;
        color: #111;
        font-size: 22px;
        font-weight: 700;
        line-height: 1.25;
      }

      #vidious-cycle-picker p {
        margin: 0 0 16px;
        color: #333;
        font-size: 14px;
        line-height: 1.45;
      }

      #vidious-cycle-picker select {
        width: 100%;
        min-height: 44px;
        padding: 8px 10px;
        border: 1px solid #bbb;
        border-radius: 8px;
        background: #fff;
        color: #111;
        font-size: 14px;
      }

      #vidious-cycle-picker .vidious-cycle-warning {
        padding: 10px 12px;
        border-radius: 8px;
        background: #fff4d6;
        color: #4b3500;
      }

      #vidious-cycle-picker .vidious-cycle-note {
        margin-top: 10px;
        color: #555;
        font-size: 12px;
      }

      #vidious-cycle-picker .vidious-cycle-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 18px;
      }

      #vidious-cycle-picker button {
        border: 0;
        border-radius: 9px;
        padding: 9px 14px;
        font-size: 14px;
        cursor: pointer;
      }

      #vidious-cycle-save-instance {
        background: #111;
        color: #fff;
      }

      #vidious-cycle-refresh-instances,
      #vidious-cycle-close-picker {
        background: #eee;
        color: #111;
      }

      #vidious-cycle-picker button:disabled,
      #vidious-cycle-picker select:disabled {
        cursor: not-allowed;
        opacity: 0.56;
      }
    `);
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== "function") {
            warn("GM_registerMenuCommand is not available.");
            return;
        }

        GM_registerMenuCommand("Choose Invidious instance", async function () {
            info("Menu command: choose instance.");

            try {
                const instances = await getAvailableInstances({ forceRefresh: true });

                showInstancePicker({
                    instances,
                    reason: "Choose your preferred Invidious instance.",
                    redirectAfterSave: Boolean(extractYouTubeVideo(location.href)),
                });
            } catch (error) {
                errorLog("Could not load instance list from menu command.", error);

                showInstancePicker({
                    instances: [],
                    reason:
                        "The Invidious instance list could not be loaded. Check the console, then try refreshing the list.",
                    redirectAfterSave: Boolean(extractYouTubeVideo(location.href)),
                });
            }
        });

        GM_registerMenuCommand("Refresh Invidious instance list", async function () {
            info("Menu command: refresh instance list.");

            try {
                const instances = await getAvailableInstances({ forceRefresh: true });
                info("Instance list refreshed.", {
                    availableInstances: instances.length,
                });
            } catch (error) {
                errorLog("Could not refresh instance list.", error);
            }
        });

        GM_registerMenuCommand("Forget selected instance", function () {
            removeStoredValue(CONFIG.selectedInstanceKey);
            info("Selected instance forgotten.");
        });
    }

    function installYouTubeNavigationWatcher() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function () {
            const result = originalPushState.apply(this, arguments);
            window.dispatchEvent(new Event("vidious-cycle-location-change"));
            return result;
        };

        history.replaceState = function () {
            const result = originalReplaceState.apply(this, arguments);
            window.dispatchEvent(new Event("vidious-cycle-location-change"));
            return result;
        };

        window.addEventListener("popstate", function () {
            scheduleCurrentLocationHandling("popstate");
        });

        window.addEventListener("vidious-cycle-location-change", function () {
            scheduleCurrentLocationHandling("history change");
        });

        window.addEventListener("yt-navigate-finish", function () {
            scheduleCurrentLocationHandling("youtube navigation");
        });

        debug("Navigation watcher installed.");
    }

    function scheduleCurrentLocationHandling(reason) {
        window.setTimeout(function () {
            handleCurrentLocation(reason).catch(function (error) {
                errorLog("Unhandled error while processing current location.", error);
            });
        }, 0);
    }

    async function handleCurrentLocation(reason) {
        const href = location.href;

        if (href === lastHandledHref) {
            debug("Skipping already handled URL.", { href, reason });
            return;
        }

        lastHandledHref = href;

        const token = ++currentHandleToken;
        const video = extractYouTubeVideo(href);

        debug("Handling current URL.", {
            reason,
            href,
            video,
        });

        if (!video) {
            debug("No supported YouTube video URL detected.");
            return;
        }

        const selectedInstance = getStoredObject(CONFIG.selectedInstanceKey, null);

        debug("Stored selected instance.", selectedInstance);

        let availableInstances = [];

        try {
            availableInstances = await getAvailableInstances({ forceRefresh: false });
        } catch (error) {
            warn("Could not refresh the Invidious instance list.", error);

            if (selectedInstance && selectedInstance.uri) {
                info("Registry unavailable. Falling back to stored instance.", {
                    uri: selectedInstance.uri,
                });

                redirectToInvidious(selectedInstance.uri, video);
                return;
            }

            showInstancePicker({
                instances: [],
                reason:
                    "The Invidious instance list could not be loaded. Check the console, then try refreshing the list.",
                redirectAfterSave: true,
            });
            return;
        }

        if (token !== currentHandleToken) {
            debug("Skipping stale handling token.");
            return;
        }

        debug("Available instances after filtering.", {
            count: availableInstances.length,
        });

        if (!selectedInstance || !selectedInstance.uri) {
            info("No selected instance found. Opening picker.");

            showInstancePicker({
                instances: availableInstances,
                reason: "No Invidious instance has been selected yet.",
                redirectAfterSave: true,
            });
            return;
        }

        const selectedStillOnline = availableInstances.some(function (instance) {
            return instance.uri === selectedInstance.uri;
        });

        if (!selectedStillOnline) {
            info("Stored instance is not currently reported online. Opening picker.", {
                selectedInstance,
            });

            showInstancePicker({
                instances: availableInstances,
                reason:
                    "Your selected Invidious instance is not currently reported as online. Choose another one.",
                redirectAfterSave: true,
            });
            return;
        }

        redirectToInvidious(selectedInstance.uri, video);
    }

    function extractYouTubeVideo(rawUrl) {
        let url;

        try {
            url = new URL(rawUrl);
        } catch {
            return null;
        }

        const hostname = url.hostname.replace(/^www\./, "");
        let videoId = null;

        if (
            (hostname === "youtube.com" || hostname === "m.youtube.com") &&
            url.pathname === "/watch"
        ) {
            videoId = url.searchParams.get("v");
        }

        if (hostname === "youtu.be") {
            videoId = url.pathname.slice(1).split("/")[0];
        }

        if (
            (hostname === "youtube.com" || hostname === "m.youtube.com") &&
            url.pathname.startsWith("/shorts/")
        ) {
            videoId = url.pathname.split("/")[2];
        }

        if (
            (hostname === "youtube.com" || hostname === "m.youtube.com") &&
            url.pathname.startsWith("/embed/")
        ) {
            videoId = url.pathname.split("/")[2];
        }

        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return null;
        }

        return {
            videoId,
            timestamp: normaliseTimestamp(
                url.searchParams.get("t") || url.searchParams.get("start")
            ),
            playlist: url.searchParams.get("list"),
            index: url.searchParams.get("index"),
        };
    }

    function redirectToInvidious(instanceUri, video) {
        const target = new URL("/watch", trimTrailingSlash(instanceUri));

        target.searchParams.set("v", video.videoId);

        if (video.timestamp) {
            target.searchParams.set("t", video.timestamp);
        }

        if (video.playlist) {
            target.searchParams.set("list", video.playlist);
        }

        if (video.index) {
            target.searchParams.set("index", video.index);
        }

        info("Redirecting to Invidious.", {
            from: location.href,
            to: target.toString(),
        });

        location.replace(target.toString());
    }

    async function getAvailableInstances(options) {
        const forceRefresh = Boolean(options && options.forceRefresh);
        const cached = getCachedInstances();

        if (!forceRefresh && cached) {
            debug("Using cached instance list.", {
                count: cached.instances.length,
                fetchedAt: new Date(cached.fetchedAt).toISOString(),
            });

            return cached.instances;
        }

        debug("Fetching Invidious instance list.", {
            url: CONFIG.instanceApiUrl,
            forceRefresh,
        });

        const rawInstances = await fetchJson(CONFIG.instanceApiUrl);
        const instances = normaliseInstances(rawInstances);

        setStoredObject(CONFIG.instanceCacheKey, {
            fetchedAt: Date.now(),
            instances,
        });

        debug("Fetched and cached instance list.", {
            count: instances.length,
        });

        return instances;
    }

    function getCachedInstances() {
        const cached = getStoredObject(CONFIG.instanceCacheKey, null);

        if (!cached || !Array.isArray(cached.instances)) {
            debug("No valid cached instance list found.");
            return null;
        }

        const fetchedAt = Number(cached.fetchedAt || 0);

        if (!fetchedAt || Date.now() - fetchedAt > CONFIG.instanceCacheTtlMs) {
            debug("Cached instance list expired.");
            return null;
        }

        return cached;
    }

    function normaliseInstances(rawInstances) {
        if (!Array.isArray(rawInstances)) {
            warn("Instance registry did not return an array.", rawInstances);
            return [];
        }

        const instances = rawInstances
            .map(function (entry) {
                const name = String(entry && entry[0] ? entry[0] : "");
                const data = entry && entry[1] ? entry[1] : {};
                const monitor = data.monitor || null;
                const stats = data.stats || {};
                const usage = stats.usage || {};
                const users = usage.users || {};
                const software = stats.software || {};

                return {
                    name,
                    uri: trimTrailingSlash(data.uri || ""),
                    region: data.region || "",
                    type: data.type || "",
                    api: Boolean(data.api),
                    cors: Boolean(data.cors),
                    version: software.version || "",
                    activeMonthUsers: Number(users.activeMonth || 0),
                    totalUsers: Number(users.total || 0),
                    uptime: monitor ? Number(monitor.uptime) : null,
                    down: monitor ? Boolean(monitor.down) : true,
                    monitorEnabled: monitor ? monitor.enabled !== false : false,
                    monitorPublished: monitor ? monitor.published !== false : false,
                    lastStatus: monitor ? Number(monitor.last_status || 0) : null,
                };
            })
            .filter(function (instance) {
                const statusLooksOk =
                    !instance.lastStatus ||
                    (instance.lastStatus >= 200 && instance.lastStatus < 400);

                return (
                    instance.type === "https" &&
                    instance.uri.startsWith("https://") &&
                    instance.down === false &&
                    instance.monitorEnabled === true &&
                    instance.monitorPublished === true &&
                    typeof instance.uptime === "number" &&
                    !Number.isNaN(instance.uptime) &&
                    instance.uptime >= CONFIG.minimumUptimePercent &&
                    statusLooksOk
                );
            })
            .sort(function (a, b) {
                if (b.uptime !== a.uptime) {
                    return b.uptime - a.uptime;
                }

                return b.activeMonthUsers - a.activeMonthUsers;
            });

        debug("Normalised instance list.", {
            rawCount: rawInstances.length,
            filteredCount: instances.length,
        });

        return instances;
    }

    function fetchJson(url) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== "function") {
                reject(new Error("GM_xmlhttpRequest is not available."));
                return;
            }

            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 10000,

                onload: function (response) {
                    debug("Registry response received.", {
                        status: response.status,
                        finalUrl: response.finalUrl || url,
                    });

                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error("HTTP " + response.status));
                        return;
                    }

                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        reject(error);
                    }
                },

                onerror: function (error) {
                    reject(error);
                },

                ontimeout: function () {
                    reject(new Error("Request timed out."));
                },
            });
        });
    }

    function showInstancePicker(options) {
        const instances = options.instances || [];
        const reason = options.reason || "Choose your preferred Invidious instance.";
        const redirectAfterSave = Boolean(options.redirectAfterSave);

        debug("Preparing instance picker.", {
            instances: instances.length,
            reason,
            redirectAfterSave,
        });

        runWhenBodyExists(function () {
            const existing = document.getElementById("vidious-cycle-picker");

            if (existing) {
                existing.remove();
            }

            const selected = getStoredObject(CONFIG.selectedInstanceKey, null);
            const overlay = buildPickerElement({
                instances,
                selected,
                reason,
                redirectAfterSave,
            });

            document.body.appendChild(overlay);

            info("Instance picker shown.", {
                instances: instances.length,
            });
        });
    }

    function buildPickerElement({ instances, selected, reason, redirectAfterSave }) {
        const overlay = document.createElement("div");
        overlay.id = "vidious-cycle-picker";

        const card = document.createElement("div");
        card.className = "vidious-cycle-card";
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");
        card.setAttribute("aria-labelledby", "vidious-cycle-title");

        const title = document.createElement("h1");
        title.id = "vidious-cycle-title";
        title.textContent = "Choose Invidious instance";

        const intro = document.createElement("p");
        intro.textContent = reason;

        card.appendChild(title);
        card.appendChild(intro);

        if (instances.length === 0) {
            const warning = document.createElement("p");
            warning.className = "vidious-cycle-warning";
            warning.textContent =
                "No monitored HTTPS instances are currently reported as online.";
            card.appendChild(warning);
        }

        const select = document.createElement("select");
        select.id = "vidious-cycle-instance-select";
        select.disabled = instances.length === 0;

        instances.forEach(function (instance) {
            const option = document.createElement("option");
            option.value = instance.uri;

            const labelParts = [
                instance.name,
                instance.region || "unknown region",
                instance.uptime.toFixed(1) + "% uptime",
            ];

            if (instance.activeMonthUsers > 0) {
                labelParts.push(instance.activeMonthUsers + " monthly users");
            }

            option.textContent = labelParts.join(" · ");

            if (selected && selected.uri === instance.uri) {
                option.selected = true;
            }

            select.appendChild(option);
        });

        const note = document.createElement("p");
        note.className = "vidious-cycle-note";
        note.textContent =
            "Only monitored HTTPS instances currently reported as online are shown. Random instance roulette is left as an exercise for people who enjoy chaos.";

        const actions = document.createElement("div");
        actions.className = "vidious-cycle-actions";

        const refreshButton = document.createElement("button");
        refreshButton.id = "vidious-cycle-refresh-instances";
        refreshButton.type = "button";
        refreshButton.textContent = "Refresh list";

        const closeButton = document.createElement("button");
        closeButton.id = "vidious-cycle-close-picker";
        closeButton.type = "button";
        closeButton.textContent = "Close";

        const saveButton = document.createElement("button");
        saveButton.id = "vidious-cycle-save-instance";
        saveButton.type = "button";
        saveButton.textContent = "Save and continue";
        saveButton.disabled = instances.length === 0;

        saveButton.addEventListener("click", function () {
            debug("Picker save clicked.", {
                selectedValue: select.value,
            });

            if (!select.value) {
                warn("Save clicked without a selected instance.");
                return;
            }

            const instance = instances.find(function (candidate) {
                return candidate.uri === select.value;
            });

            if (!instance) {
                warn("Selected instance could not be found in current list.", {
                    selectedValue: select.value,
                });
                return;
            }

            setStoredObject(CONFIG.selectedInstanceKey, instance);
            info("Selected instance saved.", instance);

            overlay.remove();

            const currentVideo = extractYouTubeVideo(location.href);

            if (redirectAfterSave && currentVideo) {
                redirectToInvidious(instance.uri, currentVideo);
            }
        });

        refreshButton.addEventListener("click", async function () {
            debug("Picker refresh clicked.");

            refreshButton.disabled = true;
            refreshButton.textContent = "Refreshing...";

            try {
                const refreshedInstances = await getAvailableInstances({
                    forceRefresh: true,
                });

                overlay.remove();

                showInstancePicker({
                    instances: refreshedInstances,
                    reason: "Instance list refreshed. Choose your preferred instance.",
                    redirectAfterSave,
                });
            } catch (error) {
                errorLog("Could not refresh instance list from picker.", error);

                refreshButton.disabled = false;
                refreshButton.textContent = "Refresh list";
            }
        });

        closeButton.addEventListener("click", function () {
            debug("Picker closed.");
            overlay.remove();
        });

        actions.appendChild(refreshButton);
        actions.appendChild(closeButton);
        actions.appendChild(saveButton);

        card.appendChild(select);
        card.appendChild(note);
        card.appendChild(actions);
        overlay.appendChild(card);

        return overlay;
    }

    function runWhenBodyExists(callback) {
        if (document.body) {
            callback();
            return;
        }

        debug("Waiting for document.body before showing picker.");

        document.addEventListener(
            "DOMContentLoaded",
            function () {
                if (document.body) {
                    callback();
                } else {
                    errorLog("document.body still unavailable after DOMContentLoaded.");
                }
            },
            { once: true }
        );
    }

    function normaliseTimestamp(value) {
        if (!value) {
            return null;
        }

        return String(value).trim();
    }

    function trimTrailingSlash(value) {
        return String(value || "").replace(/\/+$/, "");
    }

    function getStoredObject(key, fallback) {
        try {
            const value = GM_getValue(key, null);

            if (value === null || value === undefined) {
                return fallback;
            }

            if (typeof value === "string") {
                return JSON.parse(value);
            }

            return value;
        } catch (error) {
            warn("Could not read stored value.", { key, error });
            return fallback;
        }
    }

    function setStoredObject(key, value) {
        try {
            GM_setValue(key, JSON.stringify(value));
        } catch (error) {
            errorLog("Could not store value.", { key, error });
        }
    }

    function removeStoredValue(key) {
        try {
            if (typeof GM_deleteValue === "function") {
                GM_deleteValue(key);
            } else {
                GM_setValue(key, null);
            }
        } catch (error) {
            errorLog("Could not remove stored value.", { key, error });
        }
    }

    function debug(message, data) {
        if (!CONFIG.debug) {
            return;
        }

        if (data !== undefined) {
            console.debug("[Vidious Cycle]", message, data);
        } else {
            console.debug("[Vidious Cycle]", message);
        }
    }

    function info(message, data) {
        if (data !== undefined) {
            console.info("[Vidious Cycle]", message, data);
        } else {
            console.info("[Vidious Cycle]", message);
        }
    }

    function warn(message, data) {
        if (data !== undefined) {
            console.warn("[Vidious Cycle]", message, data);
        } else {
            console.warn("[Vidious Cycle]", message);
        }
    }

    function errorLog(message, data) {
        if (data !== undefined) {
            console.error("[Vidious Cycle]", message, data);
        } else {
            console.error("[Vidious Cycle]", message);
        }
    }
})();