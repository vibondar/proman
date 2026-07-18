/** Minimal vscode stub for unit tests of core modules that transitively import workspaceIo. */

export const Uri = {
  file(fsPath: string) {
    return { fsPath, path: fsPath, scheme: "file" };
  },
  joinPath(base: { fsPath?: string }, ...parts: string[]) {
    const root = base.fsPath ?? "";
    const joined = [root, ...parts].filter(Boolean).join("/").replace(/\/+/g, "/");
    return { fsPath: joined, path: joined, scheme: "file" };
  },
};

export const workspace = {
  workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string } }>,
  fs: {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
    },
    async writeFile() {
      /* no-op in tests unless overridden */
    },
    async createDirectory() {
      /* no-op */
    },
    async stat() {
      throw Object.assign(new Error("ENOENT"), { code: "FileNotFound" });
    },
  },
};

/** Identity l10n: returns English message with {n} placeholders filled. */
export const l10n = {
  t(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  },
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
};

type CmdHandler = (cmd: string, ...args: unknown[]) => Promise<unknown> | unknown;

let clipboardText = "";
let commandHandler: CmdHandler = async () => {
  throw new Error("command not stubbed");
};
const executed: Array<{ cmd: string; args: unknown[] }> = [];

export const env = {
  clipboard: {
    async writeText(text: string) {
      clipboardText = String(text);
    },
    async readText() {
      return clipboardText;
    },
  },
};

export const commands = {
  async executeCommand(cmd: string, ...args: unknown[]) {
    executed.push({ cmd, args });
    return commandHandler(cmd, ...args);
  },
};

/** Test helpers — not part of the real vscode API. */
export const __test = {
  reset() {
    clipboardText = "";
    executed.length = 0;
    commandHandler = async () => {
      throw new Error("command not stubbed");
    };
  },
  setCommandHandler(handler: CmdHandler) {
    commandHandler = handler;
  },
  getClipboard() {
    return clipboardText;
  },
  getExecuted() {
    return [...executed];
  },
};

export default { Uri, workspace, l10n, window, env, commands };
