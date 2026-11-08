import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.env.GITHUB_REPOSITORY === "elie222/rakazo") {
  throw new Error("Build Rakazo FT on macOS from the fork.");
}

const arch = process.argv[2] ?? "arm64";
if (arch !== "arm64" && arch !== "x64") {
  throw new Error("Use arm64 or x64.");
}

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
const identity = "com.forresttechnologies.rakazo.desktop";
const productName = "Rakazo FT";
const config = {
  ...pkg.build,
  appId: identity,
  productName,
  directories: { ...pkg.build.directories, output: "out/fork-macos" },
  extraMetadata: { ...pkg.build.extraMetadata, name: "rakazo-ft", productName },
  mac: { ...pkg.build.mac, identity: "-", notarize: false },
  publish: null,
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "rakazo-ft-macos-"));
try {
  const configPath = path.join(temporary, "electron-builder.json");
  await writeFile(configPath, JSON.stringify(config));
  run("pnpm", ["--filter", "@rakazo/web", "build"], root);
  run("pnpm", ["build"], desktop);
  run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--config",
      configPath,
      "--mac",
      `--${arch}`,
      "--publish",
      "never",
    ],
    desktop,
  );

  const bundleDirectory = arch === "arm64" ? "mac-arm64" : "mac";
  const bundle = path.join(
    desktop,
    config.directories.output,
    bundleDirectory,
    `${productName}.app`,
  );
  const info = path.join(bundle, "Contents", "Info.plist");
  const verified = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", info], {
    encoding: "utf8",
  });
  if (verified.status !== 0 || verified.stdout.trim() !== identity) {
    throw new Error("The packaged app does not have the fork's bundle identifier.");
  }
  try {
    await readFile(path.join(bundle, "Contents", "Resources", "app-update.yml"));
    throw new Error("The fork app unexpectedly has an update feed.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], desktop);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
