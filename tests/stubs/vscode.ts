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

export default { Uri, workspace };
