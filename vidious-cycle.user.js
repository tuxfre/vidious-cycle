// ==UserScript==
// @name         Vidious Cycle
// @namespace    xyz.vigier.userscripts.vidious-cycle
// @version      0.1.0
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
// @connect      api.invidious.io
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = {
        instanceApiUrl:
            "https://api.invidious.io/instances.json?pretty=1&sort_by=type,users",

        selectedInstanceKey: "vidiousCycle.selectedInstance",
        instanceCacheKey: "vidiousCycle.instanceCache",

        instanceCacheTtlMs: 30 * 60 * 1000,
        minimumUptimePercent: 90,
    };

    const currentVideo = extractYouTubeVideo(location.href);

    registerMenuCommands();

    if (!currentVideo) {
        return;
    }

    main().catch(function (error) {
        console.error("Vidious Cycle failed:", error);
    });

    async function main() {
        const selectedInstance = getStoredObject(CONFIG.selectedInstanceKey, null);

        let availableInstances = [];

        try {
            availableInstances = await getAvailableInstances({ forceRefresh: false });
        } catch (error) {
            console.warn("Vidious Cycle could not refresh the instance list:", error);

            /*
             * If the registry fails but the user already has a selected instance,
             * use it. The registry being down should not make the redirect useless.
             */
            if (selectedInstance && selectedInstance.uri) {
                redirectToInvidious(selectedInstance.uri, currentVideo);
                return;
            }

            showInstancePicker({
                instances: [],
                reason:
                    "The Invidious instance list could not be loaded. Refresh the list or try again later.",
                redirectAfterSave: true,
            });
            return;
        }

        if (!selectedInstance || !selectedInstance.uri) {
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
            showInstancePicker({
                instances: availableInstances,
                reason:
                    "Your selected Invidious instance is not currently reported as online. Choose another one.",
                redirectAfterSave: true,
            });
            return;
        }

        redirectToInvidious(selectedInstance.uri, currentVideo);
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== "function") {
            return;
        }

        GM_registerMenuCommand("Choose Invidious instance", async function () {
            try {
                const instances = await getAvailableInstances({ forceRefresh: true });

                showInstancePicker({
                    instances,
                    reason: "Choose your preferred Invidious instance.",
                    redirectAfterSave: Boolean(currentVideo),
                });
            } catch (error) {
                console.warn("Vidious Cycle could not load the instance list:", error);

                showInstancePicker({
                    instances: [],
                    reason:
                        "The Invidious instance list could not be loaded. Try refreshing again later.",
                    redirectAfterSave: Boolean(currentVideo),
                });
            }
        });

        GM_registerMenuCommand("Refresh Invidious instance list", async function () {
            try {
                await getAvailableInstances({ forceRefresh: true });
                alert("Vidious Cycle: instance list refreshed.");
            } catch (error) {
                console.warn("Vidious Cycle could not refresh the instance list:", error);
                alert("Vidious Cycle: could not refresh the instance list.");
            }
        });

        GM_registerMenuCommand("Forget selected instance", function () {
            removeStoredValue(CONFIG.selectedInstanceKey);
            alert("Vidious Cycle: selected instance forgotten.");
        });
    }

    function extractYouTubeVideo(rawUrl) {
        const url = new URL(rawUrl);
        const hostname = url.hostname.replace(/^www\./, "");

        let videoId = null;

        /*
         * Standard watch URL:
         * https://www.youtube.com/watch?v=dQw4w9WgXcQ
         */
        if (
            (hostname === "youtube.com" || hostname === "m.youtube.com") &&
            url.pathname === "/watch"
        ) {
            videoId = url.searchParams.get("v");
        }

        /*
         * Short URL:
         * https://youtu.be/dQw4w9WgXcQ
         */
        if (hostname === "youtu.be") {
            videoId = url.pathname.slice(1).split("/")[0];
        }

        /*
         * Shorts URL:
         * https://www.youtube.com/shorts/dQw4w9WgXcQ
         */
        if (
            (hostname === "youtube.com" || hostname === "m.youtube.com") &&
            url.pathname.startsWith("/shorts/")
        ) {
            videoId = url.pathname.split("/")[2];
        }

        /*
         * Embed URL:
         * https://www.youtube.com/embed/dQw4w9WgXcQ
         */
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

        location.replace(target.toString());
    }

    async function getAvailableInstances(options) {
        const forceRefresh = Boolean(options && options.forceRefresh);
        const cached = getCachedInstances();

        if (!forceRefresh && cached) {
            return cached.instances;
        }

        const rawInstances = await fetchJson(CONFIG.instanceApiUrl);
        const instances = normaliseInstances(rawInstances);

        setStoredObject(CONFIG.instanceCacheKey, {
            fetchedAt: Date.now(),
            instances,
        });

        return instances;
    }

    function getCachedInstances() {
        const cached = getStoredObject(CONFIG.instanceCacheKey, null);

        if (!cached || !Array.isArray(cached.instances)) {
            return null;
        }

        const fetchedAt = Number(cached.fetchedAt || 0);

        if (!fetchedAt || Date.now() - fetchedAt > CONFIG.instanceCacheTtlMs) {
            return null;
        }

        return cached;
    }

    function normaliseInstances(rawInstances) {
        if (!Array.isArray(rawInstances)) {
            return [];
        }

        return rawInstances
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
                    lastStatus: monitor ? Number(monitor.last_status || 0) : null,
                };
            })
            .filter(function (instance) {
                return (
                    instance.type === "https" &&
                    instance.uri.startsWith("https://") &&
                    instance.down === false &&
                    typeof instance.uptime === "number" &&
                    !Number.isNaN(instance.uptime) &&
                    instance.uptime >= CONFIG.minimumUptimePercent &&
                    (!instance.lastStatus || instance.lastStatus >= 200) &&
                    (!instance.lastStatus || instance.lastStatus < 400)
                );
            })
            .sort(function (a, b) {
                if (b.uptime !== a.uptime) {
                    return b.uptime - a.uptime;
                }

                return b.activeMonthUsers - a.activeMonthUsers;
            });
    }

    function fetchJson(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 10000,
                onload: function (response) {
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
                onerror: reject,
                ontimeout: reject,
            });
        });
    }

    function showInstancePicker(options) {
        const instances = options.instances || [];
        const reason = options.reason || "Choose your preferred Invidious instance.";
        const redirectAfterSave = Boolean(options.redirectAfterSave);

        runWhenDomCanHostOverlay(function () {
            const existing = document.getElementById("vidious-cycle-picker");

            if (existing) {
                existing.remove();
            }

            const selected = getStoredObject(CONFIG.selectedInstanceKey, null);
            const overlay = document.createElement("div");

            overlay.id = "vidious-cycle-picker";
            overlay.innerHTML = buildPickerHtml(instances, selected, reason);

            document.documentElement.appendChild(overlay);

            const select = overlay.querySelector("#vidious-cycle-instance-select");
            const saveButton = overlay.querySelector("#vidious-cycle-save-instance");
            const refreshButton = overlay.querySelector("#vidious-cycle-refresh-instances");
            const closeButton = overlay.querySelector("#vidious-cycle-close-picker");

            saveButton.addEventListener("click", function () {
                if (!select || !select.value) {
                    return;
                }

                const instance = instances.find(function (candidate) {
                    return candidate.uri === select.value;
                });

                if (!instance) {
                    return;
                }

                setStoredObject(CONFIG.selectedInstanceKey, instance);
                overlay.remove();

                if (redirectAfterSave && currentVideo) {
                    redirectToInvidious(instance.uri, currentVideo);
                }
            });

            refreshButton.addEventListener("click", async function () {
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
                    console.warn("Vidious Cycle could not refresh the instance list:", error);
                    refreshButton.disabled = false;
                    refreshButton.textContent = "Refresh list";
                }
            });

            closeButton.addEventListener("click", function () {
                overlay.remove();
            });
        });
    }

    function buildPickerHtml(instances, selected, reason) {
        const options = instances
            .map(function (instance) {
                const labelParts = [
                    escapeHtml(instance.name),
                    instance.region ? escapeHtml(instance.region) : "unknown region",
                    instance.uptime.toFixed(1) + "% uptime",
                ];

                if (instance.activeMonthUsers > 0) {
                    labelParts.push(instance.activeMonthUsers + " monthly users");
                }

                const isSelected =
                    selected && selected.uri === instance.uri ? " selected" : "";

                return (
                    '<option value="' +
                    escapeHtml(instance.uri) +
                    '"' +
                    isSelected +
                    ">" +
                    labelParts.join(" · ") +
                    "</option>"
                );
            })
            .join("");

        const emptyState =
            instances.length === 0
                ? '<p class="vidious-cycle-warning">No monitored HTTPS instances are currently reported as online.</p>'
                : "";

        return `
      <style>
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
      </style>

      <div class="vidious-cycle-card" role="dialog" aria-modal="true" aria-labelledby="vidious-cycle-title">
        <h1 id="vidious-cycle-title">Choose Invidious instance</h1>
        <p>${escapeHtml(reason)}</p>

        ${emptyState}

        <select id="vidious-cycle-instance-select" ${instances.length === 0 ? "disabled" : ""}>
          ${options}
        </select>

        <p class="vidious-cycle-note">
          Only monitored HTTPS instances currently reported as online are shown. Random instance roulette is left as an exercise for people who enjoy chaos.
        </p>

        <div class="vidious-cycle-actions">
          <button id="vidious-cycle-refresh-instances" type="button">Refresh list</button>
          <button id="vidious-cycle-close-picker" type="button">Close</button>
          <button id="vidious-cycle-save-instance" type="button" ${instances.length === 0 ? "disabled" : ""}>
            Save and continue
          </button>
        </div>
      </div>
    `;
    }

    function runWhenDomCanHostOverlay(callback) {
        if (document.documentElement) {
            callback();
            return;
        }

        document.addEventListener(
            "DOMContentLoaded",
            function () {
                callback();
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

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function getStoredObject(key, fallback) {
        try {
            const value = GM_getValue(key, null);

            if (value === null || value === undefined) {
                return fallback;
            }

            return JSON.parse(value);
        } catch (error) {
            console.warn("Vidious Cycle could not read stored value:", key, error);
            return fallback;
        }
    }

    function setStoredObject(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    function removeStoredValue(key) {
        if (typeof GM_deleteValue === "function") {
            GM_deleteValue(key);
            return;
        }

        GM_setValue(key, null);
    }
})();