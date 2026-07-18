import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: [
        "src/core/pathSafety.ts",
        "src/core/proposalOps.ts",
        "src/core/taskMeta.ts",
        "src/core/planFrontmatter.ts",
        "src/core/mdParser.ts",
        "src/core/mdExport.ts",
        "src/core/dependencyEngine.ts",
        "src/core/driveEngine.ts",
        "src/core/actor.ts",
        "src/core/history.ts",
        "src/core/projectMeta.ts",
        "src/core/githubIssueLink.ts",
        "src/core/gitSync.ts",
        "src/core/forest.ts",
        "src/core/taskFiles.ts",
        "src/agent/handoff.ts",
      ],
      exclude: ["src/core/workspaceIo.ts", "src/core/store.ts", "src/core/planDiscoverer.ts", "src/core/githubApi.ts"],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "tests/stubs/vscode.ts"),
    },
  },
});
