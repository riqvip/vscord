import { type Disposable, type Terminal, type TerminalShellExecution, type Uri, window } from "vscode";
import { sep } from "node:path";
import { CONFIG_KEYS } from "./constants";
import { getConfig } from "./config";
import { isCodexCommand } from "./helpers/isCodexCommand";

export interface CodexPresence {
    cwd?: Uri;
    title?: string;
}

export function formatCodexDirectory(cwd?: Uri): string | undefined {
    if (!cwd?.fsPath) return undefined;
    const home = process.env.HOME;
    const path = cwd.fsPath;
    if (home && (path === home || path.startsWith(`${home}${sep}`))) return `~${path.slice(home.length)}`;
    return path;
}

interface CodexSession {
    execution?: TerminalShellExecution;
    cwd?: Uri;
}

export function cleanTerminalTitle(title: string): string {
    return title
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 128);
}

/** Tracks both panel and editor terminals without reading terminal output or chat history. */
export class TerminalActivity implements Disposable {
    private listeners: Disposable[] = [];
    private sessions = new Map<Terminal, CodexSession>();
    private ended = new Set<Terminal>();
    private poll: NodeJS.Timeout | undefined;
    private lastSnapshot = "";

    constructor(private readonly onChange: () => void) {}

    start() {
        if (this.listeners.length) return;
        this.listeners.push(
            window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
                if (isCodexCommand(execution.commandLine.value)) {
                    this.ended.delete(terminal);
                    this.sessions.set(terminal, {
                        execution,
                        cwd: terminal.shellIntegration?.cwd ?? execution.cwd
                    });
                } else {
                    if (this.sessions.has(terminal) || /\bcodex\b/i.test(terminal.name)) this.ended.add(terminal);
                    this.sessions.delete(terminal);
                }
                this.refresh();
            }),
            window.onDidEndTerminalShellExecution(({ terminal, execution }) => {
                const session = this.sessions.get(terminal);
                if (session && (!session.execution || session.execution === execution)) {
                    this.sessions.delete(terminal);
                    this.ended.add(terminal);
                    this.refresh();
                }
            }),
            window.onDidCloseTerminal((terminal) => {
                this.sessions.delete(terminal);
                this.ended.delete(terminal);
                this.refresh();
            }),
            window.onDidChangeActiveTerminal((terminal) => {
                // Recover sessions that were already open when VSCord activated.
                // Codex's default terminal title includes its project name.
                if (
                    terminal &&
                    !this.sessions.has(terminal) &&
                    !this.ended.has(terminal) &&
                    /\bcodex\b/i.test(terminal.name)
                ) {
                    this.sessions.set(terminal, { cwd: terminal.shellIntegration?.cwd });
                }
                this.refresh();
            }),
            window.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
                const session = this.sessions.get(terminal);
                if (session && shellIntegration.cwd) {
                    session.cwd = shellIntegration.cwd;
                    this.refresh();
                }
            }),
            window.onDidChangeActiveTextEditor(() => {
                this.refresh();
            })
        );
    }

    get presence(): CodexPresence | undefined {
        const config = getConfig();
        if (!config.get(CONFIG_KEYS.Status.Codex.Enabled)) return;
        const terminal = window.activeTerminal;
        if (!terminal) return;
        let session = this.sessions.get(terminal);
        if (!session && !this.ended.has(terminal) && /\bcodex\b/i.test(terminal.name)) {
            session = { cwd: terminal.shellIntegration?.cwd };
            this.sessions.set(terminal, session);
        }
        if (!session) return;
        const title =
            config.get(CONFIG_KEYS.Status.Codex.ShowTerminalTitle) && !config.get(CONFIG_KEYS.App.PrivacyMode)
                ? cleanTerminalTitle(terminal.name)
                : undefined;
        return {
            cwd: session.cwd ?? terminal.shellIntegration?.cwd,
            title: title && !/^(codex|bash|zsh|fish|sh)$/i.test(title) ? title : undefined
        };
    }

    refresh() {
        const presence = this.presence;
        const terminal = window.activeTerminal;
        const snapshot = JSON.stringify(
            terminal && presence ? [terminal.name, presence.cwd?.toString(), presence.title] : null
        );
        if (snapshot !== this.lastSnapshot) {
            this.lastSnapshot = snapshot;
            this.onChange();
        }
        // VS Code exposes terminal names but has no stable terminal-name-change event.
        const shouldPoll =
            !!presence &&
            !!getConfig().get(CONFIG_KEYS.Status.Codex.ShowTerminalTitle) &&
            !getConfig().get(CONFIG_KEYS.App.PrivacyMode);
        if (shouldPoll && !this.poll) this.poll = setInterval(() => this.refresh(), 2000);
        if (!shouldPoll && this.poll) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
    }

    dispose() {
        for (const listener of this.listeners) listener.dispose();
        this.listeners = [];
        if (this.poll) clearInterval(this.poll);
        this.poll = undefined;
        this.sessions.clear();
        this.ended.clear();
        this.lastSnapshot = "";
    }
}
