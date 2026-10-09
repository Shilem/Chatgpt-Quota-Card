#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const REQUIRED_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "NOTICE.md",
  "README.md",
  "应用企业月额度卡片.command",
  "恢复额度卡片备份.command",
  "bin/launcher-common.zsh",
  "bin/patch-codex-quota-card.mjs",
  "bin/verify-release.mjs",
  "bin/user-assistant.mjs",
].sort();
const ALLOWED_ROOT_FILES = [...REQUIRED_FILES, "release-manifest.json"].sort();
const ALLOWED_RELEASE_DIRECTORIES = new Set(["bin"]);
const IGNORED_ROOT_DIRECTORIES = new Set([".codegraph", ".codex", ".projectmem", "backups"]);
const IGNORED_ROOT_FILES = new Set([".DS_Store", ".gitignore"]);
const PROJECT_DIRECTORIES = new Set([".git", ".github", "maintainer", "dist"]);
const projectMode = process.argv[3] === "--project";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listReleaseFiles(root, directory = root, output = []) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) fail(`发行目录包含符号链接：${relative}`);
    if (directory === root && (IGNORED_ROOT_DIRECTORIES.has(name) || (projectMode && PROJECT_DIRECTORIES.has(name)))) {
      if (!metadata.isDirectory()) fail(`${name} 必须是普通目录`);
      continue;
    }
    if (directory === root && IGNORED_ROOT_FILES.has(name)) {
      if (!metadata.isFile()) fail(`${name} 必须是普通文件`);
      continue;
    }
    if (metadata.isDirectory()) {
      if (!ALLOWED_RELEASE_DIRECTORIES.has(relative)) fail(`发行目录包含未知目录：${relative}`);
      await listReleaseFiles(root, path, output);
    }
    else if (metadata.isFile()) output.push(relative);
    else fail(`发行目录包含不受支持的条目：${relative}`);
  }
  return output;
}

try {
  const root = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) fail("缺少发行目录参数");
  if (process.argv.length > 4 || (process.argv[3] && !projectMode)) fail("未知校验参数");
  const manifestPath = join(root, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.releaseVersion) || manifest.patchMarker !== "codex-quota-card-patch:v8" || !Number.isSafeInteger(manifest.releaseRevision) || manifest.releaseRevision < 1) fail("发行清单版本或内部修订号无效");
  if (manifest.targetClient?.bundleIdentifier !== "com.openai.codex" || manifest.targetClient.version !== manifest.releaseVersion || !/^\d+$/.test(manifest.targetClient.build)) fail("发行版号必须与目标官方客户端版本一致");
  if (!Array.isArray(manifest.files)) fail("发行清单缺少文件列表");
  const listed = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(listed) !== JSON.stringify(REQUIRED_FILES)) fail("发行清单文件白名单不完整或包含额外条目");
  const actual = (await listReleaseFiles(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(ALLOWED_ROOT_FILES)) {
    const missing = ALLOWED_ROOT_FILES.filter((path) => !actual.includes(path));
    const extra = actual.filter((path) => !ALLOWED_ROOT_FILES.includes(path));
    fail(`发行目录文件集合不匹配：缺失 ${missing.join(", ") || "无"}；额外 ${extra.join(", ") || "无"}`);
  }

  for (const entry of manifest.files) {
    if (!REQUIRED_FILES.includes(entry.path) || entry.path.includes("..") || entry.path.startsWith("/")) fail(`发行文件路径无效：${entry.path}`);
    const path = join(root, entry.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`发行条目不是普通文件：${entry.path}`);
    const bytes = await readFile(path);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail(`发行文件大小或哈希不一致：${entry.path}`);
    if (entry.path.endsWith(".command") && (metadata.mode & 0o111) === 0) fail(`双击入口缺少可执行权限：${entry.path}`);
  }

  console.log(`  ✓ 发行文件完整性：${manifest.files.length} 项通过`);
} catch (error) {
  console.error(`发行完整性错误：${error.message}`);
  process.exitCode = 1;
}
