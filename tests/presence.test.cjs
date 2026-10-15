const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { test, after, beforeEach } = require("node:test");
const ts = require("typescript");
const manifest = require("../package.json");

// Run the source with the public VS Code events replaced by a small extension host.
// No Discord connection or running VS Code instance is needed for regressions.
const originalTsLoader = Module._extensions[".ts"];
Module._extensions[".ts"] = (module, filename) => {
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    });
    module._compile(outputText, filename);
};

function event() {
    const listeners = new Set();
    const register = (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
    };
    register.fire = (value) => [...listeners].forEach((listener) => listener(value));
    register.clear = () => listeners.clear();
    register.size = () => listeners.size;
    return register;
}

const defaults = Object.fromEntries(
    manifest.contributes.configuration.flatMap(({ properties }) =>
        Object.entries(properties).map(([key, value]) => [key.replace(/^vscord\./, ""), value.default])
    )
);
const settings = new Map();
const config = { get: (key, fallback) => (settings.has(key) ? settings.get(key) : (defaults[key] ?? fallback)) };
const uri = (path) => ({ fsPath: path, scheme: "file", toString: () => `file://${path}` });
const workspaceFolder = { name: "example", uri: uri("/projects/example"), index: 0 };
const document = {
    uri: uri("/projects/example/file.js"),
    fileName: "/projects/example/file.js",
    languageId: "javascript",
    lineCount: 10
};
const textEditor = { document, selection: { active: { line: 0, character: 0 } } };
const window = {
    state: { focused: true },
    activeTerminal: undefined,
    activeTextEditor: undefined,
    onDidStartTerminalShellExecution: event(),
    onDidEndTerminalShellExecution: event(),
    onDidCloseTerminal: event(),
    onDidChangeActiveTerminal: event(),
    onDidChangeTerminalShellIntegration: event(),
    onDidChangeActiveTextEditor: event(),
    onDidChangeTextEditorSelection: event(),
    onDidChangeWindowState: event(),
    showErrorMessage: () => Promise.resolve()
};
const workspace = {
    name: "example",
    workspaceFolders: [workspaceFolder],
    getConfiguration: () => config,
    getWorkspaceFolder: (value) => (value.fsPath.startsWith("/projects/example") ? workspaceFolder : undefined),
    asRelativePath: () => "file.js",
    onDidChangeTextDocument: event()
};
const debug = { onDidStartDebugSession: event(), onDidTerminateDebugSession: event() };
const languages = { onDidChangeDiagnostics: event(), getDiagnostics: () => [] };
const allEvents = [
    ...Object.values(window),
    ...Object.values(workspace),
    ...Object.values(debug),
    ...Object.values(languages)
].filter((value) => typeof value === "function" && value.fire);
const dataClass = {
    editor: undefined,
    terminalCwd: undefined,
    workspaceName: "example",
    fileSize: undefined,
    fileName: "file",
    fileExtension: ".js",
    setTerminalCwd(cwd) {
        this.terminalCwd = cwd;
    },
    get workspaceFolder() {
        return this.terminalCwd ? workspace.getWorkspaceFolder(this.terminalCwd) : workspaceFolder;
    }
};

class Client extends EventEmitter {
    isConnected = true;
    user = {
        id: "test-user",
        sent: [],
        cleared: 0,
        setActivity: async (value) => {
            this.user.sent.push(structuredClone(value));
        },
        clearActivity: async () => {
            this.user.cleared++;
        }
    };
    constructor({ clientId }) {
        super();
        this.clientId = clientId;
    }
    login() {
        return Promise.resolve();
    }
    destroy() {
        return Promise.resolve();
    }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "vscode")
        return { window, workspace, debug, languages, env: { appName: "Visual Studio Code" }, DiagnosticSeverity: {} };
    if (request === "@xhayper/discord-rpc") return { Client };
    if (request === "./data") return { dataClass };
    if (request.endsWith("/logger")) return { logInfo() {}, logError() {} };
    if (request === "./editor") return { editor: { setStatusBarItem() {} }, StatusBarMode: {} };
    return originalLoad.call(this, request, parent, isMain);
};

const { isCodexCommand } = require("../src/helpers/isCodexCommand.ts");
const { TerminalActivity, cleanTerminalTitle } = require("../src/terminal.ts");
const { RPCController } = require("../src/controller.ts");
const { activity } = require("../src/activity.ts");

after(() => {
    Module._load = originalLoad;
    if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
    else delete Module._extensions[".ts"];
});

beforeEach(() => {
    settings.clear();
    allEvents.forEach((value) => value.clear());
    window.state = { focused: true };
    window.activeTerminal = undefined;
    dataClass.editor = undefined;
    dataClass.terminalCwd = undefined;
    dataClass.fileSize = undefined;
});

const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
};
function terminal(name = "codex") {
    return { name, shellIntegration: { cwd: workspaceFolder.uri } };
}
function start(term, command = "codex") {
    const execution = { commandLine: { value: command }, cwd: term.shellIntegration?.cwd };
    window.onDidStartTerminalShellExecution.fire({ terminal: term, execution });
    return execution;
}
function focus(focused) {
    window.state = { focused };
    window.onDidChangeWindowState.fire(window.state);
}

test("recognizes interactive commands without matching mentions, maintenance, or shell scripts", () => {
    for (const command of [
        "codex",
        "codex resume --last",
        "codex fork abc",
        "/usr/local/bin/codex -m model",
        "env MODE=dev codex",
        "command codex",
        "codex -c 'model=example' resume",
        "codex 'fix the tests'",
        "codex -- 'review this'"
    ])
        assert.equal(isCodexCommand(command), true, command);
    for (const command of [
        "echo codex",
        "codex exec 'test'",
        "codex -m model login",
        "codex --help",
        "codex --version",
        "codex resume --help",
        "codex app-server",
        "codex update",
        "cd foo && codex",
        "codex &",
        "codex; echo done",
        "$(which codex)",
        "codex 'unterminated"
    ])
        assert.equal(isCodexCommand(command), false, command);
});

test("shows Codex only while its own panel or editor terminal is active", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let changes = 0;
    const tracker = new TerminalActivity(() => changes++);
    t.after(() => tracker.dispose());
    tracker.start();
    const panel = terminal("Panel session");
    const editor = terminal("Editor session");
    const panelExecution = start(panel);
    const editorExecution = start(editor, "codex resume --last");
    assert.equal(tracker.presence, undefined, "an inactive Codex terminal must not replace file presence");
    settings.set("status.codex.showTerminalTitle", true);
    window.activeTerminal = panel;
    window.onDidChangeActiveTerminal.fire(panel);
    assert.equal(tracker.presence.title, "Panel session");
    const beforeTitleChange = changes;
    panel.name = "Renamed session";
    t.mock.timers.tick(2000);
    assert.equal(changes, beforeTitleChange + 1);
    t.mock.timers.tick(2000);
    assert.equal(changes, beforeTitleChange + 1, "unchanged titles do not refresh Discord");
    window.activeTerminal = undefined;
    window.onDidChangeActiveTerminal.fire(undefined);
    assert.equal(tracker.presence, undefined, "file focus immediately restores normal presence");
    window.activeTerminal = editor;
    window.onDidChangeActiveTerminal.fire(editor);
    assert.equal(tracker.presence.title, "Editor session");
    window.onDidEndTerminalShellExecution.fire({ terminal: panel, execution: panelExecution });
    assert.equal(
        tracker.presence.title,
        "Editor session",
        "ending an inactive session cannot replace the focused session"
    );
    window.activeTerminal = panel;
    window.onDidChangeActiveTerminal.fire(panel);
    window.onDidEndTerminalShellExecution.fire({ terminal: panel, execution: panelExecution });
    assert.equal(tracker.presence, undefined);
    window.activeTerminal = editor;
    window.onDidChangeActiveTerminal.fire(editor);
    window.onDidEndTerminalShellExecution.fire({ terminal: editor, execution: editorExecution });
    assert.equal(tracker.presence, undefined);
    start(editor);
    window.onDidCloseTerminal.fire(editor);
    assert.equal(tracker.presence, undefined);
});

test("auto detects Codex tab titles and respects settings and privacy", (t) => {
    const tracker = new TerminalActivity(() => {});
    t.after(() => tracker.dispose());
    tracker.start();
    assert.equal(tracker.presence, undefined);
    window.activeTerminal = terminal("Codex Private title");
    window.onDidChangeActiveTerminal.fire(window.activeTerminal);
    const codexExecution = start(window.activeTerminal);
    assert.ok(tracker.presence);
    settings.set("status.codex.enabled", false);
    assert.equal(tracker.presence, undefined);
    settings.set("status.codex.enabled", true);
    settings.set("status.codex.showTerminalTitle", true);
    settings.set("app.privacyMode.enable", true);
    assert.equal(tracker.presence.title, undefined);
    settings.set("app.privacyMode.enable", false);
    assert.equal(tracker.presence.title, "Codex Private title");
    window.onDidEndTerminalShellExecution.fire({ terminal: window.activeTerminal, execution: codexExecution });
    assert.equal(tracker.presence, undefined, "Codex disappears when its shell execution ends");
    window.activeTerminal = undefined;
    assert.equal(tracker.presence, undefined);
    window.activeTerminal = terminal("bash");
    window.onDidChangeActiveTerminal.fire(window.activeTerminal);
    start(window.activeTerminal, "echo codex");
    assert.equal(tracker.presence, undefined);
    assert.equal(cleanTerminalTitle("\x1b[31mHello\x1b[0m\n\u202e world"), "Hello world");
    assert.equal(cleanTerminalTitle("x".repeat(200)).length, 128);
});

test("Codex uses a large OpenAI tile and small editor badge, while idle keeps its moon", async () => {
    settings.set("status.codex.showTerminalTitle", true);
    dataClass.editor = textEditor;
    const codex = { cwd: uri(`${process.env.HOME}/projects/example`), title: "Terminal awareness" };
    const card = await activity({}, false, false, codex);
    assert.match(card.details, /^Using Codex in ~\/projects\/example$/);
    assert.equal(card.state, "Terminal awareness");
    assert.match(card.largeImageKey, /\/assets\/codex\.png$/);
    assert.match(card.smallImageKey, /\/vscode\.png$/);
    const idle = await activity({}, false, true, codex);
    assert.match(idle.smallImageKey, /\/idle\.png$/);
    assert.doesNotMatch(idle.smallImageKey, /openai/);
    settings.set("app.privacyMode.enable", true);
    const privateCard = await activity({}, false, false, codex);
    assert.equal(privateCard.details, "Using Codex in current directory");
    assert.ok(!privateCard.state || !privateCard.state.includes("Terminal awareness"));
    settings.set("app.privacyMode.enable", false);
    settings.set("ignore.workspaces", ["example"]);
    const excluded = await activity({}, false, false, codex);
    assert.ok(!excluded.state || !excluded.state.includes("Terminal awareness"));
    assert.ok(!excluded.details.includes("~/projects/example"));
});

test("focused terminals stay active; repeated blur and background changes do not reset idle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10000 });
    settings.set("status.idle.timeout", 5);
    const controller = new RPCController("test");
    t.after(() => controller.destroy());
    await controller.enable();
    window.activeTerminal = terminal();
    start(window.activeTerminal);
    window.onDidChangeActiveTerminal.fire(window.activeTerminal);
    t.mock.timers.tick(10000);
    await settle();
    assert.match(controller.state.smallImageKey, /openai\.png$/);
    dataClass.editor = textEditor;
    window.activeTerminal = undefined;
    window.onDidChangeActiveTerminal.fire(undefined);
    workspace.onDidChangeTextDocument.fire({ document });
    await settle();
    assert.match(controller.state.smallImageKey, /vscode\.png$/, "editing restores the normal file card");
    focus(false);
    t.mock.timers.tick(3000);
    focus(false);
    t.mock.timers.tick(2000);
    await settle();
    assert.match(controller.state.smallImageKey, /\/idle\.png$/);
    workspace.onDidChangeTextDocument.fire({ document });
    await settle();
    assert.match(controller.state.smallImageKey, /\/idle\.png$/, "background file edits cannot wake idle");
    const backgroundCodex = terminal("Codex background");
    start(backgroundCodex, "codex resume --last");
    t.mock.timers.tick(2000);
    await settle();
    assert.match(controller.state.smallImageKey, /\/idle\.png$/, "background commands cannot wake idle");
    focus(true);
    t.mock.timers.tick(2000);
    await settle();
    assert.match(controller.state.smallImageKey, /vscode\.png$/);
    window.activeTerminal = backgroundCodex;
    window.onDidChangeActiveTerminal.fire(backgroundCodex);
    t.mock.timers.tick(2000);
    await settle();
    assert.match(controller.state.smallImageKey, /openai\.png$/);
    await controller.disable();
    assert.equal(
        allEvents.reduce((sum, value) => sum + value.size(), 0),
        0
    );
});

test("manual idle, zero timeout, live configuration and disconnect-on-idle remain effective", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10000 });
    settings.set("status.idle.timeout", 0);
    dataClass.editor = textEditor;
    const controller = new RPCController("test");
    t.after(() => controller.destroy());
    await controller.enable();
    focus(false);
    t.mock.timers.tick(600000);
    await settle();
    assert.doesNotMatch(controller.state.smallImageKey, /\/idle\.png$/);
    controller.manualIdling = true;
    await controller.sendActivity();
    assert.match(controller.state.smallImageKey, /\/idle\.png$/);
    controller.manualIdling = false;
    settings.set("status.idle.timeout", 5);
    controller.refreshConfiguration();
    t.mock.timers.tick(7000);
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    assert.match(controller.state.smallImageKey, /\/idle\.png$/);
    settings.set("status.idle.disconnectOnIdle", true);
    settings.set("status.idle.resetElapsedTime", true);
    await controller.sendActivity();
    assert.deepEqual(controller.state, {});
    assert.ok(controller.client.user.cleared > 0);
    settings.set("status.idle.check", false);
    controller.refreshConfiguration();
    await controller.sendActivity();
    assert.doesNotMatch(controller.state.smallImageKey, /\/idle\.png$/);
});

test("a slow earlier render cannot overwrite idle or publish after disabling", async (t) => {
    const controller = new RPCController("test");
    t.after(() => controller.destroy());
    let release;
    dataClass.fileSize = new Promise((resolve) => {
        release = resolve;
    });
    const older = controller.sendActivity();
    dataClass.fileSize = undefined;
    controller.manualIdling = true;
    await controller.sendActivity();
    release(0);
    await older;
    assert.match(controller.state.smallImageKey, /\/idle\.png$/);
    assert.equal(controller.client.user.sent.length, 1);

    dataClass.fileSize = new Promise((resolve) => {
        release = resolve;
    });
    const pending = controller.sendActivity();
    await controller.disable();
    release(0);
    await pending;
    assert.equal(controller.client.user.sent.length, 1);
});
