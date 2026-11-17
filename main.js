// Loads the game, installs the prepared resources and the player's saved
// files in its virtual filesystem, then starts it and keeps saving the
// player's files in the browser's storage (OPFS). A service worker (sw.js)
// keeps the large files for later visits. The offline page (web/package.py)
// sets globalThis.horizonOffline, which hands over the files it holds instead.
import "./audio.js"; // before the game's glue, which keeps the AudioContext it finds

const ROOT = ".local/horizon-client/26.3";
const status = document.getElementById("status");

// Whether this browser can draw the game; says why not on the page.
async function webgpu() {
    if (!navigator.gpu) {
        status.textContent = `Horizon needs WebGPU, which this browser doesn't offer.`;
        return false;
    }
    if (!(await navigator.gpu.requestAdapter().catch(() => null))) {
        status.textContent = "Horizon needs WebGPU, and this browser offers it but found no GPU to use " +
            `(it may be switched off, or the graphics driver not supported).`;
        return false;
    }
    return true;
}

// Starts the service worker and, on a first visit, waits briefly for it to
// take over the page, so the large files it fetches are kept.
// A host that sends no isolation headers (a static host) gets them from the
// service worker: once it controls the page, a reload makes it isolated.
async function cacheWorker() {
    const workers = navigator.serviceWorker;
    if (!workers) return;
    try {
        await workers.register("sw.js");
        if (!workers.controller) {
            await Promise.race([
                new Promise((resolve) => workers.addEventListener("controllerchange", resolve, { once: true })),
                new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
        }
    } catch (e) {
        console.warn(`Horizon: no service worker, files won't be kept for later visits: ${e}`);
        return;
    }
    if (!window.crossOriginIsolated && workers.controller && !sessionStorage.getItem("horizon-isolating")) {
        sessionStorage.setItem("horizon-isolating", "1");
        location.reload();
        await new Promise(() => {});
    }
    sessionStorage.removeItem("horizon-isolating");
}

// The large files' addresses with their content hash (build.json), which the
// service worker keeps them by. A page that can't share memory (not cross-origin
// isolated) runs the single-threaded build when the folder has it (pkg-st/).
async function versioned() {
    const files = await fetch("build.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    const at = (path) => (files[path] ? `${path}?v=${files[path]}` : path);
    const pkg = !window.crossOriginIsolated && files["pkg-st/horizon-client_bg.wasm"] ? "pkg-st" : "pkg";
    return {
        pkg,
        wasmPath: `${pkg}/horizon-client_bg.wasm`,
        wasm: at(`${pkg}/horizon-client_bg.wasm`),
        boot: at("fs/boot.tar.gz"),
    };
}

async function download(url, label, parts) {
    const cleanUrl = url.split("?")[0];
    const entry = parts[cleanUrl];
    const response = entry
        ? new Response(await joined(url, entry), { headers: { "Content-Length": String(entry.size) } })
        : await fetch(new URL(url, document.baseURI || location.href).href);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const total = Number(response.headers.get("Content-Length")) || 0;
    let received = 0;
    const counted = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            received += chunk.length;
            if (total) status.textContent = `${label} ${Math.round((received / total) * 100)}%`;
            controller.enqueue(chunk);
        },
    }));
    return counted;
}

// The player's files (options, saves) live under this folder of the
// origin's private file system, laid out as in the virtual filesystem.
async function savedRoot() {
    try {
        return await (await navigator.storage.getDirectory()).getDirectoryHandle("horizon", { create: true });
    } catch (e) {
        try {
            return await idbOpen();
        } catch (e2) {
            console.warn(`Horizon: no browser storage, nothing will be saved: ${e}; ${e2}`);
            return null;
        }
    }
}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbOpen() {
    const request = indexedDB.open("horizon", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    return idbRequest(request);
}

async function idbLoad(glue, db) {
    const files = db.transaction("files").objectStore("files");
    const [paths, records] = await Promise.all([idbRequest(files.getAllKeys()), idbRequest(files.getAll())]);
    paths.forEach((path, i) => {
        const { data, modified } = records[i];
        if (data) glue.horizon_install_saved_file(path, data, modified);
        else glue.horizon_install_saved_dir(path);
    });
    return records.filter((r) => r.data).length;
}

async function idbApply(db, path, kind, data) {
    const transaction = db.transaction("files", "readwrite");
    const files = transaction.objectStore("files");
    if (kind !== "dir") files.delete(IDBKeyRange.bound(`${path}/`, `${path}/\uffff`));
    if (kind === "gone") files.delete(path);
    else files.put(kind === "file" ? { data, modified: Date.now() } : { data: null }, path);
    await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
}

async function loadSaved(glue, dir, path) {
    if (dir instanceof IDBDatabase) return idbLoad(glue, dir);
    let files = 0;
    for await (const [name, handle] of dir.entries()) {
        const at = `${path}/${name}`;
        if (handle.kind === "directory") {
            glue.horizon_install_saved_dir(at);
            files += await loadSaved(glue, handle, at);
        } else {
            const file = await handle.getFile();
            glue.horizon_install_saved_file(at, new Uint8Array(await file.arrayBuffer()), file.lastModified);
            files += 1;
        }
    }
    return files;
}

async function folder(root, parts, create) {
    let dir = root;
    for (const part of parts) {
        try {
            dir = await dir.getDirectoryHandle(part, { create });
        } catch (e) {
            if (create && e.name === "TypeMismatchError") {
                await dir.removeEntry(part);
                dir = await dir.getDirectoryHandle(part, { create });
            } else if (e.name === "NotFoundError") {
                return null;
            } else {
                throw e;
            }
        }
    }
    return dir;
}

async function apply(root, path, kind, data) {
    if (root instanceof IDBDatabase) return idbApply(root, path, kind, data);
    const parts = path.split("/").filter(Boolean);
    if (kind === "gone") {
        const dir = await folder(root, parts.slice(0, -1), false);
        await dir?.removeEntry(parts.at(-1), { recursive: true }).catch((e) => {
            if (e.name !== "NotFoundError") throw e;
        });
    } else if (kind === "file") {
        const dir = await folder(root, parts.slice(0, -1), true);
        const name = parts.at(-1);
        let handle;
        try {
            handle = await dir.getFileHandle(name, { create: true });
        } catch (e) {
            if (e.name !== "TypeMismatchError") throw e;
            await dir.removeEntry(name, { recursive: true });
            handle = await dir.getFileHandle(name, { create: true });
        }
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    } else {
        if (kind === "cleardir") {
            const dir = await folder(root, parts.slice(0, -1), false);
            await dir?.removeEntry(parts.at(-1), { recursive: true }).catch(() => {});
        }
        await folder(root, parts, true);
    }
}

async function readZipEntry(file, wanted) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 0xFFFF - 22); at--) {
        if (view.getUint32(at, true) !== 0x06054b50) continue;
        const directorySize = view.getUint32(at + 12, true);
        const directoryOffset = view.getUint32(at + 16, true);
        let entryAt = directoryOffset;
        const end = directoryOffset + directorySize;
        while (entryAt < end && view.getUint32(entryAt, true) === 0x02014b50) {
            const nameSize = view.getUint16(entryAt + 28, true);
            const extraSize = view.getUint16(entryAt + 30, true);
            const commentSize = view.getUint16(entryAt + 32, true);
            const name = new TextDecoder().decode(bytes.subarray(entryAt + 46, entryAt + 46 + nameSize));
            if (name === wanted) {
                const method = view.getUint16(entryAt + 10, true);
                const compressedSize = view.getUint32(entryAt + 20, true);
                const localAt = view.getUint32(entryAt + 42, true);
                const localNameSize = view.getUint16(localAt + 26, true);
                const localExtraSize = view.getUint16(localAt + 28, true);
                const compressed = bytes.subarray(
                    localAt + 30 + localNameSize + localExtraSize,
                    localAt + 30 + localNameSize + localExtraSize + compressedSize);
                if (method === 0) return new TextDecoder().decode(compressed);
                if (method === 8) {
                    const stream = new Blob([compressed]).stream().pipeThrough(
                        new DecompressionStream("deflate-raw"));
                    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
                }
                return null;
            }
            entryAt += 46 + nameSize + extraSize + commentSize;
        }
        break;
    }
    return null;
}

async function updateTextSetting(glue, root, path, key, value) {
    let text = "";
    try {
        if (root instanceof IDBDatabase) {
            const record = await idbRequest(root.transaction("files").objectStore("files").get(path));
            if (record?.data) text = new TextDecoder().decode(record.data);
        } else {
            const parts = path.split("/").filter(Boolean);
            const dir = await folder(root, parts.slice(0, -1), false);
            const handle = await dir?.getFileHandle(parts.at(-1), { create: false });
            if (handle) text = await (await handle.getFile()).text();
        }
    } catch (e) {
        if (e.name !== "NotFoundError" && e.name !== "TypeMismatchError") throw e;
    }
    const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith(`${key}:`));
    lines.push(`${key}:${value}`);
    const data = new TextEncoder().encode(`${lines.join("\n")}\n`);
    glue.horizon_install_saved_file(path, data, Date.now());
    await apply(root, path, "file", data);
}

function setupModUpload(glue, root) {
    const configurePicker = (buttonId, accept, onFile) => {
        const button = document.getElementById(buttonId);
        if (!button) return;
        button.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            if (!root) {
                status.textContent = "Browser storage is unavailable; the mod was not added.";
                return;
            }
            try {
                const message = await onFile(file);
                status.textContent = `${message} Reloading…`;
                setTimeout(() => location.reload(), 500);
            } catch (e) {
                console.error(`Horizon: could not add ${file.name}:`, e);
                status.textContent = `Could not add ${file.name}: ${e}`;
            }
        };
        input.click();
        });
    };
    configurePicker("btn-mod", ".hmod", async (file) => {
        const name = file.name.split(/[\\/]/).pop() || "";
        const data = new Uint8Array(await file.arrayBuffer());
        const path = `horizon-mods/${name}`;
        glue.horizon_install_saved_file(path, data, file.lastModified || Date.now());
        await apply(root, path, "file", data);
        const manifest = await readZipEntry(file, "horizon-mod.toml");
        const id = manifest?.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1] ||
            name.replace(/\.hmod$/i, "");
        await updateTextSetting(glue, root, "horizon-mods.txt", `mod.${id}`, "true");
        return `${name} added and enabled.`;
    });
    configurePicker("btn-shader", ".hshader,.zip", async (file) => {
        const name = file.name.split(/[\\/]/).pop() || "";
        const data = new Uint8Array(await file.arrayBuffer());
        const path = `shaderpacks/${name}`;
        glue.horizon_install_saved_file(path, data, file.lastModified || Date.now());
        await apply(root, path, "file", data);
        await updateTextSetting(glue, root, "horizon-graphics.txt", "pickedShaderPack", name);
        return `${name} added and selected.`;
    });
    const disableShaders = document.getElementById("btn-shader-off");
    disableShaders?.addEventListener("click", async () => {
        if (!root) {
            status.textContent = "Browser storage is unavailable; shaders could not be disabled.";
            return;
        }
        try {
            await updateTextSetting(glue, root, "horizon-graphics.txt", "pickedShaderPack", "");
            status.textContent = "Shaders disabled. Reloading…";
            setTimeout(() => location.reload(), 500);
        } catch (e) {
            console.error("Horizon: could not disable shaders:", e);
            status.textContent = `Could not disable shaders: ${e}`;
        }
    });
}

let saving = null;
function saveChanges(glue, root) {
    saving ??= (async () => {
        for (const [path, kind, data] of glue.horizon_take_changes()) {
            try {
                await apply(root, path, kind, data);
            } catch (e) {
                console.error(`Horizon: could not save ${path}: ${e}`);
            }
        }
    })().finally(() => {
        saving = null;
    });
    return saving;
}

// Joins chunks in order and verifies file size integrity
async function joined(url, entry) {
    const version = new URL(url, document.baseURI || location.href).search;
    const pieces = await Promise.all(entry.parts.map(async (part) => {
        const partUrl = new URL(part + version, document.baseURI || location.href).href;
        const response = await fetch(partUrl);
        if (!response.ok) throw new Error(`${part}: ${response.status} ${response.statusText}`);
        return new Uint8Array(await response.arrayBuffer());
    }));
    const size = pieces.reduce((n, piece) => n + piece.length, 0);
    if (entry.size && size !== entry.size) {
        throw new Error(`the parts of ${url} are ${size} bytes, not ${entry.size}`);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
        bytes.set(piece, at);
        at += piece.length;
    }
    return bytes;
}

// The game's glue, its module and the resources
async function served() {
    await cacheWorker();
    const files = await versioned();
    status.textContent = "Loading the game…";
    const glue = await import(`./${files.pkg}/horizon-client.js`);
    const parts = await fetch("parts.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));

    // Construct WebAssembly.Module directly when using split parts
    let moduleTarget;
    if (parts[files.wasmPath]) {
        const assembled = await joined(files.wasm, parts[files.wasmPath]);
        moduleTarget = await WebAssembly.compile(assembled);
    } else {
        moduleTarget = files.wasm;
    }

    await glue.default({ module_or_path: moduleTarget });

    const gz = await download(files.boot, "Downloading resources", parts).catch((e) => {
        throw new Error(`${e}\n\nThe game's resources aren't in this folder (fs/boot.tar.gz).`);
    });
    const tar = new Uint8Array(
        await new Response(gz.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const manifest = await (await fetch("fs/manifest.txt")).text();
    return { glue, tar, manifest, base: "fs/res/" };
}

async function main() {
    if (!(await webgpu())) return;
    const { glue, tar, manifest, base } = await (globalThis.horizonOffline ?? served)();
    status.textContent = "Installing resources…";
    const t0 = performance.now();
    const installed = glue.horizon_install_tar(ROOT, tar);
    glue.horizon_install_manifest(ROOT, base, manifest);
    console.log(`Horizon: ${installed} files installed in ${Math.round(performance.now() - t0)} ms`);

    const root = await savedRoot();
    if (root) {
        const t1 = performance.now();
        const saved = await loadSaved(glue, root, "");
        console.log(`Horizon: ${saved} saved files loaded in ${Math.round(performance.now() - t1)} ms`);
        setInterval(() => saveChanges(glue, root), 2000);
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) saveChanges(glue, root);
        });
        addEventListener("pagehide", () => saveChanges(glue, root));
    }
    setupModUpload(glue, root);

    status.textContent = "Loading resources…";
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    status.textContent = "";

    const args = (new URLSearchParams(location.search).get("args") ?? "").split(" ").filter(Boolean);
    try {
        glue.horizon_start(args);
    } catch (e) {
        if (!String(e).includes("Using exceptions for control flow")) throw e;
    }
}

main().catch((e) => {
    console.error(e);
    const isolation = window.crossOriginIsolated ? "" :
        "\n\nThe page isn't cross-origin isolated: its server must send " +
        "Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.";
    status.textContent = `Horizon could not start:\n${e}${isolation}`;
});
