import { type Disposable, type WindowState, debug, languages, window, workspace } from "vscode";
import { type SetActivity, type SetActivityResponse, Client } from "@xhayper/discord-rpc";
import type { GatewayActivityButton } from "discord-api-types/v10";
import { getApplicationId } from "./helpers/getApplicationId";
import { activity, onDiagnosticsChange } from "./activity";
import { StatusBarMode, editor } from "./editor";
import { validURL } from "./helpers/validURL";
import { throttle } from "./helpers/throttle";
import { logError, logInfo } from "./logger";
import { CONFIG_KEYS } from "./constants";
import { getConfig } from "./config";
import { dataClass } from "./data";
import { TerminalActivity } from "./terminal";

export class RPCController {
    listeners: Disposable[] = [];
    enabled = true;
    canSendActivity = true;
    manualIdleMode = false;
    manualIdling = false;
    state: SetActivity = {};
    debug = false;
    client: Client;

    private idleTimeout: NodeJS.Timeout | undefined;
    private iconTimeout: NodeJS.Timeout | undefined;
    private automaticIdling = false;
    private activityRevision = 0;
    private activityThrottle = throttle((isViewing?: boolean) => this.sendActivity(isViewing), 2000, true);
    readonly terminals = new TerminalActivity(() => {
        if (this.enabled && this.client.isConnected) void this.activityThrottle.callable();
    });

    constructor(clientId: string, debug = false) {
        const config = getConfig();
        this.client = new Client({ clientId });
        this.debug = debug;
        this.manualIdleMode = config.get(CONFIG_KEYS.Status.Idle.Check) === false;

        editor.setStatusBarItem(StatusBarMode.Pending);

        this.client.login().catch(async (error: Error) => {
            const config = getConfig();

            logError("Encountered following error while trying to login:", error);
            editor.setStatusBarItem(StatusBarMode.Disconnected);
            editor.errorMessageFailedToConnect(config, error);
            await this.client?.destroy();
            logInfo("[002] Destroyed Discord RPC client");
        });

        this.client.on("debug", (...data) => {
            if (!this.debug) return;
            logInfo("[003] Debug:", ...data);
        });

        this.client.on("ready", this.onReady.bind(this));
        this.client.on("disconnected", this.onDisconnected.bind(this));
    }

    private onReady() {
        logInfo("Successfully connected to Discord");
        this.cleanUp();

        if (this.enabled) void this.enable();
        editor.setStatusBarItem(StatusBarMode.Succeeded);
    }

    private onDisconnected() {
        this.cleanUp();
        editor.setStatusBarItem(StatusBarMode.Disconnected);
    }

    private listen() {
        const fileSwitch = window.onDidChangeActiveTextEditor((e) => {
            logInfo("onDidChangeActiveTextEditor()");
            void this.activityThrottle.callable(!!e);
        });
        const fileEdit = workspace.onDidChangeTextDocument((e) => {
            if (e.document !== dataClass.editor?.document) return;
            logInfo("onDidChangeTextDocument()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const fileSelectionChanged = window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor !== dataClass.editor) return;
            logInfo("onDidChangeTextEditorSelection()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const debugStart = debug.onDidStartDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const debugEnd = debug.onDidTerminateDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const diagnosticsChange = languages.onDidChangeDiagnostics(() => {
            if (getConfig().get(CONFIG_KEYS.Status.Problems.Enabled)) onDiagnosticsChange();
        });
        const changeWindowState = window.onDidChangeWindowState((e: WindowState) => {
            logInfo("onDidChangeWindowState()");
            this.checkIdle(e);
        });

        this.terminals.start();
        this.terminals.refresh();
        // A focused window must never start an automatic idle timer.
        this.checkIdle(window.state);
        this.listeners.push(
            fileSwitch,
            fileEdit,
            fileSelectionChanged,
            debugStart,
            debugEnd,
            diagnosticsChange,
            changeWindowState
        );
    }

    private checkCanSend(isIdling: boolean): boolean {
        const config = getConfig();
        let userId = this.client.user?.id;
        if (!userId) return false;
        if (isIdling && config.get(CONFIG_KEYS.Status.Idle.DisconnectOnIdle)) return (this.canSendActivity = false);
        let whitelistEnabled = config.get(CONFIG_KEYS.App.WhitelistEnabled);
        if (whitelistEnabled) {
            let whitelist = config.get(CONFIG_KEYS.App.Whitelist);
            if (config.get(CONFIG_KEYS.App.whitelistIsBlacklist))
                if (whitelist!.includes(userId)) return (this.canSendActivity = false);
                else return (this.canSendActivity = true);
            else if (!whitelist!.includes(userId)) return (this.canSendActivity = false);
        }
        return (this.canSendActivity = true);
    }

    private checkIdle(windowState: WindowState) {
        if (!this.enabled) return;
        const config = getConfig();
        const timeout = config.get(CONFIG_KEYS.Status.Idle.Timeout) ?? 300;
        if (windowState.focused || !config.get(CONFIG_KEYS.Status.Idle.Check) || timeout <= 0) {
            this.clearIdleTimer();
            this.automaticIdling = false;
            void this.activityThrottle.callable();
        } else if (!this.idleTimeout && !this.automaticIdling) {
            this.idleTimeout = setTimeout(() => {
                this.idleTimeout = undefined;
                const current = getConfig();
                if (
                    !this.enabled ||
                    window.state.focused ||
                    !current.get(CONFIG_KEYS.Status.Idle.Check) ||
                    (current.get(CONFIG_KEYS.Status.Idle.Timeout) ?? 300) <= 0
                )
                    return;
                this.automaticIdling = true;
                void this.activityThrottle.callable();
            }, timeout * 1000);
        }
    }

    private clearIdleTimer() {
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        this.idleTimeout = undefined;
    }

    refreshConfiguration() {
        this.manualIdleMode = getConfig().get(CONFIG_KEYS.Status.Idle.Check) === false;
        this.clearIdleTimer();
        this.terminals.refresh();
        this.checkIdle(window.state);
        if (this.enabled) void this.activityThrottle.callable();
    }

    async login() {
        const { clientId } = getApplicationId(getConfig());
        logInfo("[004] Debug:", `Logging in with client ID "${clientId}"`);
        logInfo("[004] Debug:", "Login - isConnected", this.client.isConnected, "isReady", this.client.clientId);
        logInfo("[004] Debug:", `Login - ${this.client}`);

        if (this.client.isConnected && this.client.clientId === clientId) return;

        editor.setStatusBarItem(StatusBarMode.Pending);

        if (this.client.clientId !== clientId) await this.updateClientId(clientId);
        else if (!this.client.isConnected) await this.client.login();
    }

    async sendActivity(isViewing = false): Promise<SetActivityResponse | undefined> {
        if (!this.enabled) return;
        // Every update uses the current idle state, including background file and terminal events.
        const isIdling = this.manualIdling || (!this.manualIdleMode && this.automaticIdling);
        this.checkCanSend(isIdling);
        const codex = this.terminals.presence;
        dataClass.setTerminalCwd(codex?.cwd);
        const revision = ++this.activityRevision;
        const state = await activity({ ...this.state }, isViewing, isIdling, codex);
        if (!this.enabled || revision !== this.activityRevision) return;
        this.state = state;
        if (!this.state || Object.keys(this.state).length === 0 || !this.canSendActivity)
            return void this.client.user?.clearActivity(process.pid);
        this.state.instance = true;
        const filteredButton: GatewayActivityButton[] = [];
        this.state.buttons = (this.state.buttons ?? []).filter((button) => {
            const isValid = validURL(button.url);
            if (!isValid) filteredButton.push(button);
            return isValid;
        });

        if (filteredButton.length > 0)
            logInfo(
                "[005]",
                "Invalid buttons!\n",
                filteredButton.map((button) => JSON.stringify(button, null, 2)).join("\n")
            );

        return this.client.user?.setActivity(this.state, process.pid);
    }

    async disable() {
        this.enabled = false;

        this.cleanUp();
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        if (this.iconTimeout) clearTimeout(this.iconTimeout);

        await this.client.user?.clearActivity(process.pid);
    }

    async enable() {
        logInfo("[004] Debug:", "Enabling Discord Rich Presence");

        this.enabled = true;

        await this.login();
        logInfo("[004] Debug:", "Client Should be logged in");
        logInfo("[004] Debug:", `Enable - ${this.client}`);

        editor.setStatusBarItem(StatusBarMode.Succeeded);

        logInfo("[004] Debug:", "Enabled - isConnected", this.client.isConnected, "isReady", this.client.clientId);
        this.cleanUp();
        this.listen();
        await this.activityThrottle.callable();

        if (this.iconTimeout) clearTimeout(this.iconTimeout);
    }

    async updateClientId(clientId: string) {
        if (this.client.clientId === clientId) return;
        await this.client.destroy();
        this.client.clientId = clientId;
        await this.client.login();
        if (this.enabled) await this.sendActivity();
    }

    cleanUp() {
        this.activityRevision++;
        this.clearIdleTimer();
        this.automaticIdling = false;
        this.activityThrottle.reset();
        this.terminals.dispose();
        dataClass.setTerminalCwd(undefined);
        for (const listener of this.listeners) listener.dispose();
        this.listeners = [];
    }

    async destroy() {
        await this.disable();
        await this.client.destroy();
    }
}
