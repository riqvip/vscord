// Recognize the executable, never a mention of Codex in another command's arguments.
// This deliberately accepts simple invocations only; aliases and shell scripts can
// use the manual terminal command instead. Nothing here executes shell input.
export function isCodexCommand(commandLine: string): boolean {
    const tokens: string[] = [];
    let token = "";
    let quote = "";
    let escaped = false;
    let started = false;

    for (const character of commandLine.trim()) {
        if (escaped) {
            token += character;
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
            started = true;
        } else if (quote) {
            if (character === quote) quote = "";
            else token += character;
        } else if (character === "'" || character === '"') {
            quote = character;
            started = true;
        } else if (/[;&|<>`$\n\r]/.test(character)) {
            return false;
        } else if (/\s/.test(character)) {
            if (started) tokens.push(token);
            token = "";
            started = false;
        } else {
            token += character;
            started = true;
        }
    }
    if (quote || escaped) return false;
    if (started) tokens.push(token);

    let index = 0;
    if (tokens[index] === "env") index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
    if (tokens[index] === "command") index++;
    if (tokens[index]?.split("/").pop() !== "codex") return false;
    index++;

    const endOfOptions = tokens.indexOf("--", index);
    if (
        tokens
            .slice(index, endOfOptions < 0 ? undefined : endOfOptions)
            .some((argument) => ["-h", "--help", "-V", "--version"].includes(argument))
    )
        return false;

    const valueFlags = new Set([
        "-c",
        "--config",
        "-m",
        "--model",
        "-p",
        "--profile",
        "-s",
        "--sandbox",
        "-a",
        "--ask-for-approval",
        "-C",
        "--cd",
        "--add-dir",
        "--enable",
        "--disable",
        "-i",
        "--image",
        "--local-provider",
        "--remote",
        "--remote-auth-token-env"
    ]);
    const maintenance = new Set([
        "agents",
        "exec",
        "e",
        "review",
        "login",
        "logout",
        "mcp",
        "plugin",
        "app-server",
        "remote-control",
        "completion",
        "update",
        "doctor",
        "sandbox",
        "debug",
        "apply",
        "a",
        "queue",
        "archive",
        "delete",
        "migrate-rollouts",
        "unarchive",
        "cloud",
        "exec-server",
        "features",
        "help"
    ]);

    for (; index < tokens.length; index++) {
        const argument = tokens[index];
        if (argument === "--") return true;
        if (valueFlags.has(argument)) {
            if (!tokens[++index]) return false;
        } else if (!argument.startsWith("-")) {
            return !maintenance.has(argument);
        }
    }
    return true;
}
