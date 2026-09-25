import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const toml = readFileSync(path.join(root, "millennium.toml"), "utf8");

const section = (name) =>
  toml.match(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? "";
const field = (body, key) =>
  body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

const plugin = section("plugin");
const id = field(plugin, "id");
const version = field(plugin, "version");

if (!id || !version) {
  console.error("build: 无法从 millennium.toml 的 [plugin] 读取 id 或 version");
  process.exit(1);
}

mkdirSync(path.join(root, "dist"), { recursive: true });

const localBin = path.join(root, "node_modules", ".bin", "starlight");
execFileSync(existsSync(localBin) ? localBin : "starlight", ["pack", "--release"], {
  cwd: root,
  stdio: "inherit",
});

const configured = field(section("compiler"), "output_path");
const built = path.resolve(
  root,
  configured?.endsWith(".star") ? configured : path.join("dist", `${id}.star`),
);

if (!existsSync(built)) {
  console.log(
    `build: ${path.relative(root, built)} 不存在，跳过重命名（output_path 为 "auto" 时 starlight 会直接写入插件目录）`,
  );
  process.exit(0);
}

const versioned = path.join(path.dirname(built), `${id}-${version}.star`);
renameSync(built, versioned);
console.log(`build: 产物 ${path.relative(root, versioned)}`);
