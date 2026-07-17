import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

mkdirSync(join(__dirname, "dist"), { recursive: true });
mkdirSync(join(__dirname, "mcp"), { recursive: true });

const extensionBuild = await esbuild.context({
  entryPoints: [join(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: join(__dirname, "dist/extension.js"),
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
});

const mcpBuild = await esbuild.context({
  entryPoints: [join(__dirname, "mcp/server.mjs")],
  bundle: true,
  outfile: join(__dirname, "mcp/server.cjs"),
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "info",
});

async function rebuildAll() {
  await Promise.all([extensionBuild.rebuild(), mcpBuild.rebuild()]);
}

await rebuildAll();

if (watch) {
  await Promise.all([extensionBuild.watch(), mcpBuild.watch()]);
  console.log("watching…");
} else {
  await Promise.all([extensionBuild.dispose(), mcpBuild.dispose()]);
}
