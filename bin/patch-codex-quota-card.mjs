#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import {
  copyFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCH_MARKER = "codex-quota-card-patch:v8";
export const LEGACY_PATCH_MARKERS = [
  "codex-quota-card-patch:v1",
  "codex-quota-card-patch:v2",
  "codex-quota-card-patch:v3",
  "codex-quota-card-patch:v4",
  "codex-quota-card-patch:v5",
  "codex-quota-card-patch:v6",
  "codex-quota-card-patch:v7",
];
export const MANIFEST_VERSION = 2;

const TOOL_NAME = "codex-quota-card-patcher";
const COLLAPSED_MOUNT_MARKER = "codex-quota-card-collapsed-disabled";
const MONTHLY_LIMIT_MARKER = "codex-quota-monthly-limit:v2";
const ENTERPRISE_PLAN_MARKER = "codex-quota-enterprise-plan:v1";
const DEFAULT_APP = "/Applications/ChatGPT.app";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const INTEGRITY_KEY = ":ElectronAsarIntegrity:Resources/app.asar:hash";
const MARKERS = [PATCH_MARKER, ...LEGACY_PATCH_MARKERS];
const QUOTA_ANCHOR = "Title for the dismissible sidebar card shown when core usage is low";
const QUOTA_SCAN_NEEDLES = [...MARKERS, QUOTA_ANCHOR].map((value) => Buffer.from(value, "utf8"));
export const VERIFIED_APP_VERSIONS = ["26.715.70719", "26.715.72359"];
export const SUPPORTED_APP_VERSIONS = VERIFIED_APP_VERSIONS;
export const SUPPORTED_BUNDLE_IDENTIFIERS = ["com.openai.codex"];
const OFFICIAL_TEAM_IDENTIFIER = "2DC432GLL2";
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const ASAR_INTEGRITY_DIGEST_SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A", "ascii");
const ASAR_INTEGRITY_DIGEST_SIZE = 32;
const FRAMEWORK_RELATIVE_PATH = "Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework";
const EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX = 4;
const ONLY_LOAD_APP_FROM_ASAR_FUSE_INDEX = 5;
const DISK_SAFETY_BYTES = 64 * 1024 * 1024;
const RESTRICTED_ADHOC_ENTITLEMENTS = [
  "com.apple.application-identifier",
  "com.apple.developer.aps-environment",
  "com.apple.developer.usernotifications.communication",
  "com.apple.developer.team-identifier",
  "com.apple.security.application-groups",
  "keychain-access-groups",
];
const ENTITLEMENT_SIGNING_TARGETS = [
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Alerts).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (GPU).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Renderer).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Service).app",
  "Contents/Frameworks/Sparkle.framework/Versions/Current/XPCServices/Downloader.xpc",
  "Contents/Frameworks/Sparkle.framework/Versions/Current/XPCServices/Installer.xpc",
];
const APERITIF_ENTITLEMENT_SIGNING_TARGETS = [
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Aperitif Alerts).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Aperitif GPU).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Aperitif Renderer).app",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/Codex (Aperitif).app",
];
const EXECUTABLE_SIGNING_TARGETS = [
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/app_mode_loader",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/browser_crashpad_handler",
  "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/web_app_shortcut_copier",
  "Contents/Frameworks/Sparkle.framework/Versions/Current/Autoupdate",
];
const CONTAINER_SIGNING_TARGETS = [
  "Contents/Frameworks/Sparkle.framework/Versions/Current/Updater.app",
  "Contents/Frameworks/Codex Framework.framework",
  "Contents/Frameworks/Sparkle.framework",
  "Contents/PlugIns/CodexDockTilePlugin.docktileplugin",
];
const NATIVE_LIBRARY_SIGNING_TARGETS = [
  "Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "Contents/Resources/app.asar.unpacked/node_modules/objc-js/prebuilds/darwin-arm64/node.napi.armv8.node",
  "Contents/Resources/native/sky.node",
  "Contents/Resources/native/browser-use-peer-authorization.node",
  "Contents/Resources/native/usb_webauthn.node",
];

export function inspectNativeSigningTargets(appPath) {
  return NATIVE_LIBRARY_SIGNING_TARGETS.filter(relative => {
    const target = join(appPath, relative);
    let stat;
    try { stat = lstatSync(target); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!stat.isFile()) fail(`原生库签名目标不是普通文件：${relative}`);
    return true;
  });
}

function fail(message) {
  throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function count(source, needle) {
  let result = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    result += 1;
    offset += needle.length;
  }
  return result;
}

function exactlyOne(values, label) {
  if (values.length !== 1) fail(`${label}应恰好匹配 1 处，实际为 ${values.length} 处`);
  return values[0];
}

function findMatches(source, expression) {
  return [...source.matchAll(expression)];
}

function findMatchingBrace(source, opening) {
  let depth = 0;
  let mode = "code";
  let escaped = false;
  let regexClass = false;
  let lastToken = null;
  const templateExpressionDepths = [];
  const regexKeywords = new Set(["return", "case", "throw", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await"]);
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "regex") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "[") regexClass = true;
      else if (char === "]") regexClass = false;
      else if (char === "/" && !regexClass) {
        mode = "code";
        lastToken = "value";
      }
      continue;
    }
    if (mode === "template") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "`") {
        mode = "code";
        lastToken = "value";
      } else if (char === "$" && next === "{") {
        depth += 1;
        templateExpressionDepths.push(depth);
        mode = "code";
        lastToken = "{";
        index += 1;
      }
      continue;
    }
    if (mode === '"' || mode === "'") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === mode) {
        mode = "code";
        lastToken = "value";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block";
      index += 1;
    } else if (char === '"' || char === "'") mode = char;
    else if (char === "`") mode = "template";
    else if (char === "/") {
      const canStartRegex = lastToken == null
        || regexKeywords.has(lastToken)
        || ["(", "[", "{", "=", ",", ":", ";", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"].includes(lastToken);
      if (canStartRegex) {
        mode = "regex";
        regexClass = false;
      } else lastToken = "/";
    } else if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w$]/.test(source[end])) end += 1;
      lastToken = source.slice(index, end);
      index = end - 1;
    } else if (/\d/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w.]/.test(source[end])) end += 1;
      lastToken = "value";
      index = end - 1;
    } else if (char === "{") {
      depth += 1;
      lastToken = "{";
    } else if (char === "}") {
      if (templateExpressionDepths.at(-1) === depth) {
        depth -= 1;
        templateExpressionDepths.pop();
        mode = "template";
        lastToken = "value";
      } else if (--depth === 0) return index + 1;
      else lastToken = "value";
    } else if (!/\s/.test(char)) {
      lastToken = [")", "]"].includes(char) ? "value" : char;
    }
  }
  fail("目标组件的花括号不完整");
}

function findContainingFunction(source, anchorOffset) {
  const matches = findMatches(source.slice(0, anchorOffset + 1), /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g);
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const opening = match.index + match[0].lastIndexOf("{");
    const functionEnd = findMatchingBrace(source, opening);
    if (functionEnd > anchorOffset) {
      let end = functionEnd;
      while (end < source.length && source[end] === " ") end += 1;
      return { name: match[1], start: match.index, end, text: source.slice(match.index, end) };
    }
  }
  fail("找不到包含额度卡片锚点的函数");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUniqueJsxCaller(source, calleeName, label) {
  const expression = new RegExp(
    `\\(0,[A-Za-z_$][\\w$]*\\.(?:jsx|jsxs)\\)\\(${escapeRegExp(calleeName)},\\{`,
    "g",
  );
  const callers = new Map();
  for (const match of findMatches(source, expression)) {
    const caller = findContainingFunction(source, match.index);
    callers.set(`${caller.start}:${caller.end}`, caller);
  }
  return exactlyOne([...callers.values()], label);
}

function findJsxCallSet(source, calleeName, strict = false) {
  const callPrefix = new RegExp(
    `\\(0,[A-Za-z_$][\\w$]*\\.(?:jsx|jsxs)\\)\\(${escapeRegExp(calleeName)},\\{`,
    "g",
  );
  const callExpression = new RegExp(
    strict
      ? `\\(0,[A-Za-z_$][\\w$]*\\.(?:jsx|jsxs)\\)\\(${escapeRegExp(calleeName)},(?:\\{className:\`[^\`]*\`\\}|\\{\\},\`usage-alert\`)\\)`
      : `\\(0,[A-Za-z_$][\\w$]*\\.(?:jsx|jsxs)\\)\\(${escapeRegExp(calleeName)},(?:\\{className:[^}]*\\}|\\{\\},\`usage-alert\`)\\)`,
    "g",
  );
  const prefixMatches = findMatches(source, callPrefix);
  const calls = findMatches(source, callExpression).map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    caller: findContainingFunction(source, match.index),
  }));
  return { prefixMatches, calls };
}

function findChainedSidebarMountContract(source, quotaComponent) {
  let calleeName = quotaComponent.name;
  let wrapper = null;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(calleeName)) return null;
    visited.add(calleeName);
    const { prefixMatches, calls } = findJsxCallSet(source, calleeName);
    if (calls.length === 0) return null;
    const hasRootMount = calls.some(({ text, caller }) => (
      text.endsWith(",{},`usage-alert`)")
      || caller.text.includes("absolute inset-x-0 bottom-0")
      || (
        caller.text.includes("pointer-events-none fixed")
        && caller.text.includes("left-[var(--padding-row-x)]")
      )
    ));
    if (hasRootMount) return { wrapper: wrapper ?? calls[0].caller, prefixMatches, calls };
    if (prefixMatches.length !== calls.length || calls.length !== 1 || !calls[0].text.includes("{className:")) {
      return null;
    }
    wrapper = calls[0].caller;
    calleeName = wrapper.name;
  }
  return null;
}

function classifySidebarMountContract(source, wrapper, prefixMatches, calls, isCurrent) {
  if (prefixMatches.length !== calls.length) {
    fail(`额度卡片挂载调用应使用受支持的布局契约，实际调用 ${prefixMatches.length} 处，可解析 ${calls.length} 处`);
  }

  const sidebarCalls = calls.filter(({ text, caller }) => (
    text.endsWith(",{},`usage-alert`)")
    || caller.text.includes("absolute inset-x-0 bottom-0")
  ));
  const collapsedCalls = calls.filter(({ caller }) => (
    caller.text.includes("pointer-events-none fixed")
    && caller.text.includes("left-[var(--padding-row-x)]")
  ));
  const classified = new Set([...sidebarCalls, ...collapsedCalls]);
  if (classified.size !== calls.length) fail("额度卡片存在无法识别的挂载区域");
  const sidebarCall = exactlyOne(sidebarCalls, "侧边栏底部额度卡片挂载");

  const disabledMarkers = findMatches(source, new RegExp(escapeRegExp(COLLAPSED_MOUNT_MARKER), "g"));
  if (isCurrent) {
    if (collapsedCalls.length !== 0) fail("v8 侧边栏收起态不得继续挂载浮动额度卡片");
    if (disabledMarkers.length > 1) fail(`v8 收起态禁用标记应至多出现 1 次，实际为 ${disabledMarkers.length} 处`);
    if (disabledMarkers.length === 1) {
      const disabledCaller = findContainingFunction(source, disabledMarkers[0].index);
      if (
        !disabledCaller.text.includes("pointer-events-none fixed")
        || !disabledCaller.text.includes("left-[var(--padding-row-x)]")
      ) {
        fail("v8 收起态禁用标记不在固定浮动挂载区域");
      }
    }
  } else {
    if (disabledMarkers.length !== 0) fail("旧补丁结构不应包含 v8 收起态禁用标记");
    if (collapsedCalls.length > 1) fail(`收起态浮动额度卡片挂载应至多匹配 1 处，实际为 ${collapsedCalls.length} 处`);
  }

  return {
    wrapper,
    sidebarCall,
    collapsedCall: collapsedCalls[0] ?? null,
    collapsedMountDisabled: disabledMarkers.length === 1,
  };
}

function inspectSidebarMountContract(source, quotaComponent, isCurrent) {
  const wrapper = findUniqueJsxCaller(source, quotaComponent.name, "额度卡片鉴权包装组件");
  const { prefixMatches, calls } = findJsxCallSet(source, wrapper.name, true);
  if (prefixMatches.length !== calls.length) {
    const chained = findChainedSidebarMountContract(source, quotaComponent);
    if (chained) return classifySidebarMountContract(
      source,
      chained.wrapper,
      chained.prefixMatches,
      chained.calls,
      isCurrent,
    );
  }
  return classifySidebarMountContract(source, wrapper, prefixMatches, calls, isCurrent);
}

function findRateLimitData(component) {
  return findMatches(
    component.text,
    /\{data:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\1===void 0\?null:\1/g,
  );
}

function resolveQuotaComponent(source, anchorComponent) {
  const localMatches = findRateLimitData(anchorComponent);
  if (localMatches.length === 1) return { component: anchorComponent, dataMatch: localMatches[0], componentDepth: 0 };
  if (localMatches.length > 1) fail(`额度状态 Hook 应恰好匹配 1 处，实际为 ${localMatches.length} 处`);

  const parent = findUniqueJsxCaller(source, anchorComponent.name, "额度提醒父组件");
  const parentMatches = findRateLimitData(parent);
  const dataMatch = exactlyOne(parentMatches, "额度状态 Hook");
  return { component: parent, dataMatch, componentDepth: 1 };
}

function resolveAsarModulePath(sourcePath, modulePath) {
  if (!sourcePath || !modulePath.startsWith(".")) return null;
  return normalize(join(dirname(sourcePath), modulePath)).replaceAll("\\", "/").replace(/^\.\//, "");
}

function importedBindings(specifiers) {
  return specifiers.split(",").map((specifier) => specifier.trim()).filter(Boolean).map((specifier) => {
    const match = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    return match ? { imported: match[1], local: match[2] ?? match[1] } : null;
  }).filter(Boolean);
}

function findImportedMonthlyProvider(source, { sourcePath = null, moduleSources = new Map() } = {}) {
  const imports = findMatches(source, /import\{([^}]*)\}from"([^"]+)";/g);
  const providers = [];
  for (const target of imports) {
    const [specifiers, module] = [target[1], target[2]];
    if (module.includes("crseajay")) {
      const aliases = findMatches(specifiers, /(?:^|,)\s*v\s+as\s+([A-Za-z_$][\w$]*)/g);
      providers.push({
        kind: "import",
        name: aliases.length === 1 ? aliases[0][1] : "monthlyQuotaQuery",
        start: target.index,
        end: target.index + target[0].length,
        text: target[0],
        specifiers,
        module,
        alias: aliases.length === 1 ? aliases[0][1] : null,
        aliasCount: aliases.length,
      });
      continue;
    }
    const modulePath = resolveAsarModulePath(sourcePath, module);
    const importedModule = modulePath ? moduleSources.get(modulePath) : null;
    if (!importedModule) continue;
    const localProvider = findLocalMonthlyProvider(importedModule.text);
    if (!localProvider) continue;
    for (const binding of importedBindings(specifiers)) {
      if (binding.imported !== localProvider.exportAlias) continue;
      providers.push({
        kind: "import",
        name: binding.local,
        start: target.index,
        end: target.index + target[0].length,
        text: target[0],
        specifiers,
        module,
        alias: binding.local,
        aliasCount: 1,
      });
    }
  }
  return providers.length === 0 ? null : exactlyOne(providers, "月额度查询模块 import");
}

function findLocalMonthlyProvider(source) {
  const endpoint = "/accounts/{account_id}/spend-controls/current-user/monthly-usage";
  const hits = findMatches(source, new RegExp(escapeRegExp(endpoint), "g"));
  if (hits.length === 0) return null;
  const hit = exactlyOne(hits, "本地月额度查询端点");
  const component = findContainingFunction(source, hit.index);
  const parameters = component.text.match(
    /\{accountId:[A-Za-z_$][\w$]*,enabled:[A-Za-z_$][\w$]*(?:,isPolling:([A-Za-z_$][\w$]*))?\}=[A-Za-z_$][\w$]*/,
  );
  if (!parameters) {
    fail("本地月额度查询函数缺少 accountId/enabled 参数契约");
  }
  if (!component.text.includes("refetchInterval:") || !component.text.includes("ONE_MINUTE")) {
    fail("本地月额度查询函数缺少一分钟刷新契约");
  }
  if (parameters[1]) {
    const polling = escapeRegExp(parameters[1]);
    const defaultPolling = extractOne(
      component.text,
      new RegExp(`\\b([A-Za-z_$][\\w$]*)=${polling}===void 0\\|\\|${polling}(?:,|;)`, "g"),
      "本地月额度查询默认轮询开关",
    );
    const interval = extractOne(
      component.text,
      new RegExp(`\\b([A-Za-z_$][\\w$]*)=${escapeRegExp(defaultPolling)}\\?[A-Za-z_$][\\w$]*\\.ONE_MINUTE:!1(?:,|;)`, "g"),
      "本地月额度查询轮询间隔",
    );
    if (!component.text.includes(`refetchInterval:${interval}`)) fail("本地月额度查询缺少默认一分钟刷新契约");
  }
  const exports = findMatches(
    source,
    new RegExp(`\\b${escapeRegExp(component.name)}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"),
  );
  if (exports.length !== 1) fail(`本地月额度查询函数顶层导出应恰好匹配 1 处，实际为 ${exports.length} 处`);
  return {
    kind: "local",
    name: component.name,
    component,
    exportName: component.name,
    exportAlias: exports[0][1],
    alias: component.name,
    aliasCount: 1,
  };
}

function findLocalUsageWindowMapper(source) {
  const hits = findMatches(
    source,
    /\.find\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.limitName==null\)/g,
  );
  const candidates = new Map();
  for (const hit of hits) {
    const component = findContainingFunction(source, hit.index);
    if (
      component.text.includes("snapshot.primary")
      && component.text.includes("usedPercent:")
      && component.text.includes("windowMinutes:")
      && component.text.includes("resetsAt:")
    ) {
      candidates.set(`${component.start}:${component.end}`, component);
    }
  }
  if (candidates.size === 0) return null;
  const component = exactlyOne([...candidates.values()], "额度窗口规范化函数");
  const exports = findMatches(
    source,
    new RegExp(`\\b${escapeRegExp(component.name)}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"),
  );
  if (exports.length !== 1) fail(`额度窗口规范化函数顶层导出应恰好匹配 1 处，实际为 ${exports.length} 处`);
  return { name: component.name, exportName: component.name, exportAlias: exports[0][1] };
}

function findImportedUsageWindowMapper(source, component, dataValues, { sourcePath = null, moduleSources = new Map() } = {}) {
  const values = Array.isArray(dataValues) ? dataValues : [dataValues];
  const imports = findMatches(source, /import\{([^}]*)\}from"([^"]+)";/g);
  const mappers = [];
  for (const target of imports) {
    const modulePath = resolveAsarModulePath(sourcePath, target[2]);
    const importedModule = modulePath ? moduleSources.get(modulePath) : null;
    if (!importedModule) continue;
    const localMapper = findLocalUsageWindowMapper(importedModule.text);
    if (!localMapper) continue;
    for (const binding of importedBindings(target[1])) {
      if (binding.imported !== localMapper.exportAlias) continue;
      const calls = values.flatMap((dataValue) => findMatches(
        component.text,
        new RegExp(`${escapeRegExp(binding.local)}\\(${escapeRegExp(dataValue)}\\)`, "g"),
      ));
      if (calls.length === 0) continue;
      if (calls.length !== 1) fail(`额度窗口规范化函数调用应恰好匹配 1 处，实际为 ${calls.length} 处`);
      mappers.push({
        kind: "import",
        name: binding.local,
        module: target[2],
        alias: binding.local,
        aliasCount: 1,
      });
    }
  }
  if (mappers.length > 1) fail(`额度窗口规范化能力应恰好匹配 1 处，实际为 ${mappers.length} 处`);
  return mappers[0] ?? null;
}

function findEnterprisePlanPredicate(source, { sourcePath = null, moduleSources = new Map() } = {}) {
  const candidates = [];
  for (const imported of findMatches(source, /import\{([^}]*)\}from"([^"]+)";/g)) {
    const module = moduleSources.get(resolveAsarModulePath(sourcePath, imported[2]));
    if (!module) continue;
    const exports = findMatches(module.text, /export\{([^}]*)\}/g).flatMap(match => importedBindings(match[1]));
    for (const match of findMatches(module.text, /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2!=null&&([A-Za-z_$][\w$]*)\.includes\(\2\)\}/g)) {
      const lists = findMatches(module.text, new RegExp(`${escapeRegExp(match[3])}=\\[([^\\]]*)\\]`, "g"));
      if (lists.length !== 1) continue;
      const literal = lists[0][1];
      if (!/^[`"'][A-Za-z0-9_]+[`"'](?:,[`"'][A-Za-z0-9_]+[`"'])*$/.test(literal)) continue;
      const plans = literal.split(",").map(value => value.slice(1, -1));
      // Identify the native managed-enterprise family, not a generic paid-plan list.
      if (!["enterprise", "business", "edu"].every(plan => plans.includes(plan))
        || ["free", "plus", "pro", "team"].some(plan => plans.includes(plan))) continue;
      const names = exports.filter(binding => binding.imported === match[1]).map(binding => binding.local);
      for (const binding of importedBindings(imported[1])) {
        if (names.includes(binding.imported)) candidates.push(binding.local);
      }
    }
  }
  return exactlyOne(candidates, "原生企业账户套餐判定能力");
}

function findMonthlyProvider(source, context = {}) {
  const providers = [
    findImportedMonthlyProvider(source, context),
    findLocalMonthlyProvider(source),
  ].filter(Boolean);
  return exactlyOne(providers, "月额度查询能力");
}

function extractOne(source, expression, label, group = 1) {
  const values = [...new Set(findMatches(source, expression).map((match) => match[group]))];
  return exactlyOne(values, label);
}

export function analyzeSource(source, context = {}) {
  const genericMarkers = findMatches(source, /codex-quota-card-patch:v\d+/g).map((match) => match[0]);
  const unknownMarkers = [...new Set(genericMarkers.filter((marker) => !MARKERS.includes(marker)))];
  if (unknownMarkers.length) fail(`发现不受支持的补丁版本：${unknownMarkers.join(", ")}`);
  const markerHits = MARKERS.flatMap((marker) => Array.from({ length: count(source, marker) }, () => marker));
  if (markerHits.length > 1) fail(`补丁版本标记应至多出现 1 次，实际为 ${markerHits.length} 次`);
  const marker = markerHits[0] ?? null;
  const isCurrent = marker === PATCH_MARKER;
  let anchorOffset = marker ? source.indexOf(marker) : source.indexOf(QUOTA_ANCHOR);
  if (anchorOffset < 0) fail("找不到侧边栏额度卡片语义锚点");
  if (!marker && count(source, QUOTA_ANCHOR) !== 1) fail(`侧边栏额度卡片语义锚点应恰好出现 1 次，实际为 ${count(source, QUOTA_ANCHOR)} 次`);
  const anchorComponent = findContainingFunction(source, anchorOffset);
  const { component, dataMatch, componentDepth } = resolveQuotaComponent(source, anchorComponent);
  const mountContract = inspectSidebarMountContract(source, component, isCurrent);

  const authHook = extractOne(
    source,
    /\{authMethod:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(\)/g,
    "ChatGPT 鉴权 Hook",
  );
  const jsx = extractOne(component.text, /\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\(/g, "JSX 运行时");
  const classMerge = extractOne(component.text, /(?:className:|=)([A-Za-z_$][\w$]*)\(`(?:w-full|mx-2(?: mb-2)?)`/g, "样式合并函数");
  const entryMatches = findMatches(source, /([A-Za-z_$][\w$]*)\([^)]*\)\.find\([^=]*=>[^=]*\.limitName==null\)/g);
  const entryNames = [...new Set(entryMatches.map((match) => match[1]))];
  if (entryNames.length > 1) fail(`额度入口映射函数应恰好匹配 1 处，实际为 ${entryNames.length} 处`);
  const entryMapper = entryNames[0] ?? null;
  const usageWindowMapper = entryMapper
    ? null
    : findImportedUsageWindowMapper(source, component, [dataMatch[1], dataMatch[4]], context);
  if (!entryMapper && !usageWindowMapper) fail("额度入口映射函数应恰好匹配 1 处，实际为 0 处");
  const bucketMapper = entryMapper
    ? extractOne(source, /([A-Za-z_$][\w$]*)\(\{entry:[^,}]+,keyPrefix:/g, "额度窗口映射函数")
    : null;
  const monthlyProvider = findMonthlyProvider(source, context);
  const enterprisePlanPredicate = findEnterprisePlanPredicate(source, context);
  const monthlyImport = monthlyProvider.kind === "import" ? monthlyProvider : null;
  if (monthlyImport?.aliasCount > 1) fail("月额度 Hook 导入重复");
  if (monthlyImport && (isCurrent || LEGACY_PATCH_MARKERS.slice(2).includes(marker)) && monthlyImport.aliasCount !== 1) {
    fail("已安装补丁缺少唯一的月额度 Hook 导入");
  }
  if (isCurrent) {
    const requiredSemantics = [
      ["effective_monthly_limit", "Monthly 总额度字段"],
      ["current_month_usage", "Monthly 已用额度字段"],
      ["`Monthly`", "Monthly 标签"],
      ["`5h`", "5h 标签"],
      ["`Weekly`", "Weekly 标签"],
      ["accountId:", "月额度账户参数"],
      ["enabled:", "月额度启用参数"],
      ["sidebar-quota-card", "额度窗口映射键"],
    ];
    for (const [needle, label] of requiredSemantics) {
      if (count(component.text, needle) !== 1) fail(`v8 ${label}应恰好出现 1 次，实际为 ${count(component.text, needle)} 次`);
    }
    if (component.text.includes(ENTERPRISE_PLAN_MARKER)) {
      if (count(component.text, ENTERPRISE_PLAN_MARKER) !== 1 || count(component.text, "plan_type") !== 1 || component.text.includes("@shopee.com")) fail("v8 企业账户套餐契约无效");
      const gate = extractOne(component.text, new RegExp(`([A-Za-z_$][\\w$]*)=${escapeRegExp(enterprisePlanPredicate)}\\(${escapeRegExp(dataMatch[4])}\\?\\.plan_type\\),\\{data:`, "g"), "企业账户套餐判断");
      if (!component.text.includes(`enabled:${gate}}`) || !component.text.includes(`=${gate}?[`)) fail("v8 企业账户判定未同时控制Monthly查询和卡片分流");
    } else if (count(component.text, "@shopee.com") !== 1) fail("旧v8企业邮箱契约无效");
    if (component.text.includes(MONTHLY_LIMIT_MARKER)) {
      for (const needle of [MONTHLY_LIMIT_MARKER, "limit_amount", "balance_unit", "limit_mode", "unlimited_platform_max"]) {
        if (count(component.text, needle) !== 1) fail(`Monthly 新版额度契约 ${needle} 应恰好出现 1 次`);
      }
    }
    const currentRootSpacing = `${classMerge}(\`mx-2 mb-2\`,`;
    const previousRootSpacing = `${classMerge}(\`mx-2\`,`;
    const horizontalSpacingCount = count(component.text, "mx-2");
    const bottomSpacingCount = count(component.text, "mb-2");
    if (horizontalSpacingCount > 1) fail(`v8 卡片水平间距应至多出现 1 次，实际为 ${horizontalSpacingCount} 次`);
    if (bottomSpacingCount > 1) fail(`v8 卡片底部间距应至多出现 1 次，实际为 ${bottomSpacingCount} 次`);
    if (horizontalSpacingCount === 1 && !component.text.includes(currentRootSpacing) && !component.text.includes(previousRootSpacing)) {
      fail("v8 卡片水平间距不在根布局节点");
    }
    if (bottomSpacingCount === 1 && !component.text.includes(currentRootSpacing)) fail("v8 卡片底部间距不在根布局节点");
    if (/["'`]progress["'`]/.test(component.text)) fail("v8 额度卡片不应包含进度条");
    if (!component.text.includes(`=${monthlyProvider.name}({accountId:`)) fail("v8 额度卡片没有调用已解析的 Monthly Hook");
    try {
      // The body only references globals; parsing is sufficient here.
      new Function(component.text);
    } catch (error) {
      fail(`v8 额度卡片语法无效：${error.message}`);
    }
  }
  return {
    status: isCurrent
      ? component.text.includes(`${classMerge}(\`mx-2 mb-2\`,`) && component.text.includes(MONTHLY_LIMIT_MARKER) && component.text.includes(ENTERPRISE_PLAN_MARKER)
        ? "already-patched"
        : "upgrade-ready"
      : marker ? "upgrade-ready" : "ready",
    marker,
    component,
    anchorComponent,
    componentDepth,
    monthlyProvider,
    monthlyImport,
    mountContract,
    aliases: {
      authHook,
      dataValue: dataMatch[4],
      dataHook: dataMatch[2],
      rateLimitAtom: dataMatch[3],
      jsx,
      classMerge,
      entryMapper,
      bucketMapper,
      usageWindowMapper: usageWindowMapper?.name ?? null,
      monthlyQuotaQuery: monthlyProvider.name,
      enterprisePlanPredicate,
    },
  };
}

function allocateIdentifiers(source, excluded, amount) {
  const used = new Set(findMatches(source, /[A-Za-z_$][\w$]*/g).map((match) => match[0]));
  for (const name of excluded) used.add(name);
  const result = [];
  for (let index = 0; result.length < amount; index += 1) {
    const candidate = `$q${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function buildComponent(source, analysis, monthlyAlias) {
  const a = analysis.aliases;
  const q = allocateIdentifiers(source, Object.values(a), 31);
  const [props, className, rateResult, rateData, account, corporate, monthlyResult, entry, buckets, fiveBucket,
    weeklyBucket, normalize, bucket, usedPercent, resetsAt, remaining, resetLabel, fiveRow, weeklyRow,
    limit, usage, validMonthly, monthlyRemaining, formatNumber, monthlyRow, renderRow, rows,
    monthlyLimit, limitAmount, balanceUnit, parseNumber] = q;
  const quotaSetup = a.usageWindowMapper
    ? `${buckets}=${a.usageWindowMapper}(${rateResult})??[]`
    : `${entry}=${a.entryMapper}(${rateData}).find(${props}=>${props}.limitName==null),${buckets}=${entry}==null?[]:${a.bucketMapper}({entry:${entry},keyPrefix:\`sidebar-quota-card\`}).map(${props}=>${props}.bucket)`;
  const windowField = a.usageWindowMapper ? "windowMinutes" : "windowDurationMins";
  const semanticMarker = a.usageWindowMapper ? "void`sidebar-quota-card`;" : "";
  // Match the native Usage page: prefer the amount in the response's unit,
  // only use the legacy credit limit when the unit permits it, and keep null unknown.
  const monthlySetup = `${monthlyLimit}=${monthlyResult}?.effective_monthly_limit,${limitAmount}=${monthlyLimit}?.limit_amount,${balanceUnit}=${monthlyResult}?.balance_unit??\`credit\`,${parseNumber}=${props}=>${props}==null?NaN:Number(${props}),${limit}=${monthlyLimit}?.limit_mode===\`unlimited_platform_max\`?NaN:${limitAmount}?.unit===${balanceUnit}?${parseNumber}(${limitAmount}.amount):${balanceUnit}===\`usd\`?NaN:${parseNumber}(${monthlyLimit}?.limit),${usage}=${parseNumber}(${monthlyResult}?.current_month_usage)`;
  return `function ${analysis.component.name}(${props}){void\`${PATCH_MARKER}\`;void\`${MONTHLY_LIMIT_MARKER}\`;void\`${ENTERPRISE_PLAN_MARKER}\`;${semanticMarker}let{className:${className}}=${props},{data:${rateResult}}=${a.dataHook}(${a.rateLimitAtom}),${rateData}=${rateResult}===void 0?null:${rateResult},${account}=${a.authHook}(),${corporate}=${a.enterprisePlanPredicate}(${rateData}?.plan_type),{data:${monthlyResult}}=${monthlyAlias}({accountId:${rateData}?.account_id??null,enabled:${corporate}}),${quotaSetup},${fiveBucket}=${buckets}.find(${props}=>Number.isFinite(${props}?.${windowField})&&${props}.${windowField}>=240&&${props}.${windowField}<=360)??null,${weeklyBucket}=${buckets}.find(${props}=>Number.isFinite(${props}?.${windowField})&&${props}.${windowField}>=10000&&${props}.${windowField}<=10200)??null,${normalize}=${bucket}=>{let ${usedPercent}=${bucket}?.usedPercent,${resetsAt}=${bucket}?.resetsAt,${remaining}=Number.isFinite(${usedPercent})?Math.min(Math.max(100-${usedPercent},0),100):null,${resetLabel}=Number.isFinite(${resetsAt})?new Intl.DateTimeFormat(void 0,{month:\`short\`,day:\`numeric\`,hour:\`2-digit\`,minute:\`2-digit\`}).format(new Date(${resetsAt}*1e3)):\`Unavailable\`;return{remaining:${remaining},metaLabel:\`Resets\`,metaValue:${resetLabel}}},${fiveRow}=${normalize}(${fiveBucket}),${weeklyRow}=${normalize}(${weeklyBucket}),${monthlySetup},${validMonthly}=Number.isFinite(${limit})&&${limit}>=0&&Number.isFinite(${usage}),${monthlyRemaining}=${validMonthly}?${limit}===0?0:Math.min(Math.max(100-${usage}/${limit}*100,0),100):null,${formatNumber}=${props}=>Number.isFinite(${props})?new Intl.NumberFormat(void 0,{maximumFractionDigits:2}).format(Math.max(${props},0)):\`—\`,${monthlyRow}={remaining:${monthlyRemaining},metaLabel:\`Used\`,metaValue:${validMonthly}?${formatNumber}(${usage})+\` / \`+${formatNumber}(${limit}):\`Unavailable\`},${renderRow}=(${props},${className})=>{let ${rateResult}=${className}.remaining==null?\`—\`:String(Math.round(${className}.remaining))+\`%\`;return(0,${a.jsx}.jsxs)(\`div\`,{className:\`flex flex-col gap-1\`,children:[(0,${a.jsx}.jsxs)(\`div\`,{className:\`flex items-center justify-between gap-3 text-sm\`,children:[(0,${a.jsx}.jsx)(\`span\`,{className:\`font-medium\`,children:${props}}),(0,${a.jsx}.jsx)(\`span\`,{className:\`tabular-nums\`,children:${rateResult}})]}),(0,${a.jsx}.jsxs)(\`div\`,{className:\`flex items-center justify-between gap-3 text-xs text-token-text-secondary\`,children:[(0,${a.jsx}.jsx)(\`span\`,{children:${className}.metaLabel}),(0,${a.jsx}.jsx)(\`span\`,{className:\`tabular-nums\`,children:${className}.metaValue})]})]})},${rows}=${corporate}?[${renderRow}(\`Monthly\`,${monthlyRow})]:[${renderRow}(\`5h\`,${fiveRow}),${renderRow}(\`Weekly\`,${weeklyRow})];return(0,${a.jsx}.jsx)(\`div\`,{className:${a.classMerge}(\`mx-2 mb-2\`,${className}),children:(0,${a.jsx}.jsxs)(\`div\`,{role:\`status\`,"aria-live":\`polite\`,className:\`flex w-full flex-col gap-3 rounded-2xl border border-token-border bg-token-main-surface-primary p-3 text-left text-token-foreground\`,children:[(0,${a.jsx}.jsx)(\`div\`,{className:\`text-base font-medium\`,children:\`Usage\`}),...${rows}]})})}`;
}

export function patchSource(source, context = {}) {
  const analysis = analyzeSource(source, context);
  if (analysis.status === "already-patched") return { ...analysis, source };
  const provider = analysis.monthlyProvider;
  const importInfo = provider.kind === "import" ? provider : null;
  const monthlyAlias = provider.name;
  const newImport = !importInfo
    ? null
    : importInfo.alias
      ? importInfo.text
      : `import{${importInfo.specifiers},v as ${monthlyAlias}}from"${importInfo.module}";`;
  const generated = buildComponent(source, analysis, monthlyAlias);
  const importDelta = importInfo ? Buffer.byteLength(newImport) - Buffer.byteLength(importInfo.text) : 0;
  const componentBudget = Buffer.byteLength(analysis.component.text) - importDelta;
  const generatedSize = Buffer.byteLength(generated);
  if (generatedSize > componentBudget) {
    fail(`新额度卡片需要 ${generatedSize} 字节，但可用空间只有 ${componentBudget} 字节`);
  }
  const padded = generated + " ".repeat(componentBudget - generatedSize);
  const collapsedMountEdit = analysis.mountContract.collapsedCall == null
    ? null
    : {
        start: analysis.mountContract.collapsedCall.start,
        end: analysis.mountContract.collapsedCall.end,
        value: `null/*${COLLAPSED_MOUNT_MARKER}*/`,
      };
  if (
    collapsedMountEdit
    && Buffer.byteLength(collapsedMountEdit.value) > collapsedMountEdit.end - collapsedMountEdit.start
  ) {
    fail("收起态禁用标记超过原浮动挂载的可用空间");
  }
  if (collapsedMountEdit) {
    collapsedMountEdit.value += " ".repeat(
      collapsedMountEdit.end - collapsedMountEdit.start - Buffer.byteLength(collapsedMountEdit.value),
    );
  }
  const edits = [
    ...(importInfo ? [{ start: importInfo.start, end: importInfo.end, value: newImport }] : []),
    ...(collapsedMountEdit ? [collapsedMountEdit] : []),
    { start: analysis.component.start, end: analysis.component.end, value: padded },
  ].sort((left, right) => right.start - left.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  if (Buffer.byteLength(output) !== Buffer.byteLength(source)) fail("补丁破坏了分包字节长度");
  const verified = analyzeSource(output, context);
  if (verified.status !== "already-patched") fail("生成后的补丁未通过结构校验");
  return { ...verified, status: "patched", source: output };
}

function walkAsarFiles(node, prefix = "", output = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walkAsarFiles(entry, path, output);
    else output.push({ path, ...entry });
  }
  return output;
}

export function parseAsar(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) fail("app.asar 头部格式无效");
  const headerBlockSize = buffer.readUInt32LE(4);
  const headerStringSize = buffer.readUInt32LE(12);
  const dataOffset = 8 + headerBlockSize;
  if (16 + headerStringSize > buffer.length || dataOffset > buffer.length) fail("app.asar 头部长度越界");
  let header;
  try {
    header = JSON.parse(buffer.subarray(16, 16 + headerStringSize).toString("utf8"));
  } catch (error) {
    fail(`app.asar 文件表无法解析：${error.message}`);
  }
  return { header, dataOffset, files: walkAsarFiles(header) };
}

export function asarIntegrityHash(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) fail("app.asar 头部格式无效");
  const headerStringSize = buffer.readUInt32LE(12);
  const headerEnd = 16 + headerStringSize;
  if (headerEnd > buffer.length) fail("app.asar 头部长度越界");
  return sha256(buffer.subarray(16, headerEnd));
}

function fileBytes(buffer, parsed, file) {
  if (file.unpacked) fail(`目标分包 ${file.path} 位于 unpacked 目录，当前工具不支持`);
  const start = parsed.dataOffset + Number(file.offset ?? 0);
  const end = start + Number(file.size);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < parsed.dataOffset || end > buffer.length) {
    fail(`ASAR 文件 ${file.path} 的偏移越界`);
  }
  return { start, end, bytes: buffer.subarray(start, end) };
}

function inspectFileIntegrity(bytes, integrity) {
  if (!integrity) return { present: false, valid: null, reason: null };
  if (integrity.algorithm !== "SHA256") {
    return { present: true, valid: false, reason: `不支持的算法 ${integrity.algorithm ?? "unknown"}` };
  }
  const blockSize = Number(integrity.blockSize);
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || !Array.isArray(integrity.blocks)) {
    return { present: true, valid: false, reason: "分块元数据无效" };
  }
  const actualHash = sha256(bytes);
  const actualBlocks = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    actualBlocks.push(sha256(bytes.subarray(offset, Math.min(offset + blockSize, bytes.length))));
  }
  const valid = integrity.hash === actualHash
    && integrity.blocks.length === actualBlocks.length
    && integrity.blocks.every((hash, index) => hash === actualBlocks[index]);
  return {
    present: true,
    valid,
    reason: valid ? null : "目标分包内容与 ASAR 文件表中的整体或分块哈希不一致",
    actualHash,
    recordedHash: integrity.hash ?? null,
    blockSize,
    blockCount: actualBlocks.length,
  };
}

function findAsarEntry(node, targetPath, prefix = "") {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === targetPath) return entry;
    if (entry.files) {
      const match = findAsarEntry(entry, targetPath, path);
      if (match) return match;
    }
  }
  return null;
}

function rewriteAsarFileIntegrity(buffer, targetPath) {
  const parsed = parseAsar(buffer);
  const entry = findAsarEntry(parsed.header, targetPath);
  if (!entry || entry.files) fail(`找不到目标分包 ${targetPath} 的 ASAR 文件表条目`);
  const region = fileBytes(buffer, parsed, { path: targetPath, ...entry });
  if (entry.integrity?.algorithm !== "SHA256" || !Array.isArray(entry.integrity.blocks)) {
    fail(`目标分包 ${targetPath} 的完整性元数据格式不受支持，拒绝重写`);
  }
  const blockSize = Number(entry.integrity.blockSize);
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) fail(`目标分包 ${targetPath} 的完整性分块大小无效`);
  const blocks = [];
  for (let offset = 0; offset < region.bytes.length; offset += blockSize) {
    blocks.push(sha256(region.bytes.subarray(offset, Math.min(offset + blockSize, region.bytes.length))));
  }
  entry.integrity = { ...entry.integrity, hash: sha256(region.bytes), blocks };
  const headerStringSize = buffer.readUInt32LE(12);
  const nextHeader = Buffer.from(JSON.stringify(parsed.header), "utf8");
  if (nextHeader.length !== headerStringSize) fail("ASAR 文件表重写后长度变化，拒绝修改完整性元数据");
  const next = Buffer.from(buffer);
  nextHeader.copy(next, 16);
  const verifiedParsed = parseAsar(next);
  const verifiedFile = verifiedParsed.files.find((file) => file.path === targetPath);
  if (!verifiedFile) fail(`重写后找不到目标分包 ${targetPath}`);
  const verifiedRegion = fileBytes(next, verifiedParsed, verifiedFile);
  const verified = inspectFileIntegrity(verifiedRegion.bytes, verifiedFile.integrity);
  if (!verified.valid) fail(`重写后的目标分包 ${targetPath} 完整性校验失败`);
  return { buffer: next, after: verified, integrityHash: asarIntegrityHash(next) };
}

function buildAsarModuleSources(buffer, parsed, candidate) {
  const files = new Map(parsed.files.map((file) => [file.path, file]));
  const moduleSources = new Map();
  const imports = findMatches(candidate.text, /import\{[^}]*\}from"([^"]+)";/g);
  for (const match of imports) {
    const modulePath = resolveAsarModulePath(candidate.file.path, match[1]);
    const moduleFile = modulePath ? files.get(modulePath) : null;
    if (!modulePath || !moduleFile || moduleFile.unpacked || !moduleFile.path.endsWith(".js")) continue;
    const region = fileBytes(buffer, parsed, moduleFile);
    moduleSources.set(modulePath, { path: modulePath, text: region.bytes.toString("utf8") });
  }
  return moduleSources;
}

export function inspectAsarBuffer(buffer) {
  const parsed = parseAsar(buffer);
  const candidates = [];
  for (const file of parsed.files) {
    if (!file.path.endsWith(".js") || !file.size || file.unpacked) continue;
    const region = fileBytes(buffer, parsed, file);
    if (QUOTA_SCAN_NEEDLES.some((needle) => region.bytes.includes(needle))) {
      const text = region.bytes.toString("utf8");
      candidates.push({ file, region, text });
    }
  }
  const candidate = exactlyOne(candidates, "额度卡片 JavaScript 分包");
  const context = {
    sourcePath: candidate.file.path,
    moduleSources: buildAsarModuleSources(buffer, parsed, candidate),
  };
  return {
    ...candidate,
    context,
    entryIntegrity: inspectFileIntegrity(candidate.region.bytes, candidate.file.integrity),
    analysis: analyzeSource(candidate.text, context),
  };
}

export function patchAsarBuffer(buffer, { rewriteIntegrity = false } = {}) {
  const inspected = inspectAsarBuffer(buffer);
  if (rewriteIntegrity && (!inspected.entryIntegrity.present || !inspected.entryIntegrity.valid)) {
    fail(`目标分包 ${inspected.file.path} 的原始完整性元数据无效，拒绝重写`);
  }
  const result = patchSource(inspected.text, inspected.context);
  if (result.status === "already-patched") return { buffer, inspected, result };
  const nextBytes = Buffer.from(result.source, "utf8");
  if (nextBytes.length !== inspected.region.bytes.length) fail("目标分包替换后字节长度变化");
  const next = Buffer.from(buffer);
  nextBytes.copy(next, inspected.region.start);
  const integrity = rewriteIntegrity ? rewriteAsarFileIntegrity(next, inspected.file.path) : null;
  const output = integrity?.buffer ?? next;
  inspectAsarBuffer(output);
  return { buffer: output, inspected, result, integrity };
}

function run(executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) fail(`${basename(executable)} 无法执行：${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`${basename(executable)} 执行失败（${result.status}）：${(result.stderr || result.stdout || "无输出").trim()}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runAsync(executable, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectPromise(new Error(`${basename(executable)} 无法执行：${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => rejectPromise(new Error(`${basename(executable)} 无法执行：${error.message}`)));
    child.once("close", (status) => {
      const result = { status, stdout, stderr };
      if (!allowFailure && status !== 0) {
        rejectPromise(new Error(`${basename(executable)} 执行失败（${status}）：${(stderr || stdout || "无输出").trim()}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function plistRead(plistPath, key) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, plistPath]).stdout.trim();
}

function plistIdentity(plistPath) {
  return {
    bundleIdentifier: plistRead(plistPath, ":CFBundleIdentifier"),
    version: plistRead(plistPath, ":CFBundleShortVersionString"),
  };
}

function updatePlistIntegrityHash(plist, expectedHash, nextHash) {
  const source = Buffer.from(plist).toString("utf8");
  const matches = [...source.matchAll(/(<key>ElectronAsarIntegrity<\/key>[\s\S]*?<key>Resources\/app\.asar<\/key>[\s\S]*?<key>hash<\/key>\s*<string>)([a-f0-9]{64})(<\/string>)/g)];
  if (matches.length !== 1 || matches[0][2] !== expectedHash) {
    fail("Info.plist 的 ElectronAsarIntegrity 结构与当前记录不一致，拒绝更新");
  }
  const match = matches[0];
  const start = match.index + match[1].length;
  const end = start + match[2].length;
  const next = Buffer.from(`${source.slice(0, start)}${nextHash}${source.slice(end)}`, "utf8");
  if (next.length !== plist.length) fail("Info.plist 完整性字段更新后长度变化");
  return next;
}

function integrityDictionaryDigest(headerHash) {
  return createHash("sha256").update(`Resources/app.asarSHA256${headerHash}`, "utf8").digest();
}

function inspectFrameworkIntegrityDigest(bytes, headerHash) {
  const offset = bytes.indexOf(ASAR_INTEGRITY_DIGEST_SENTINEL);
  if (offset < 0) return { present: false, valid: true };
  if (bytes.indexOf(ASAR_INTEGRITY_DIGEST_SENTINEL, offset + 1) >= 0
    || offset + ASAR_INTEGRITY_DIGEST_SENTINEL.length + 2 + ASAR_INTEGRITY_DIGEST_SIZE > bytes.length) {
    fail("Framework 内嵌 ASAR 完整性摘要标记不唯一或长度无效");
  }
  const used = bytes[offset + ASAR_INTEGRITY_DIGEST_SENTINEL.length];
  const version = bytes[offset + ASAR_INTEGRITY_DIGEST_SENTINEL.length + 1];
  if (used !== 0 && used !== 1) fail(`Framework 内嵌 ASAR 完整性摘要状态不受支持：${used}`);
  if (used === 1 && version !== 1) fail(`Framework 内嵌 ASAR 完整性摘要版本不受支持：${version}`);
  const digestOffset = offset + ASAR_INTEGRITY_DIGEST_SENTINEL.length + 2;
  return {
    present: true,
    used: used === 1,
    digestOffset,
    valid: used === 0 || bytes.subarray(digestOffset, digestOffset + ASAR_INTEGRITY_DIGEST_SIZE)
      .equals(integrityDictionaryDigest(headerHash)),
  };
}

function patchFrameworkIntegrityDigest(bytes, inspection, nextHash) {
  if (!inspection.used) return bytes;
  const next = Buffer.from(bytes);
  integrityDictionaryDigest(nextHash).copy(next, inspection.digestOffset);
  if (!inspectFrameworkIntegrityDigest(next, nextHash).valid) fail("Framework 内嵌 ASAR 完整性摘要更新失败");
  return next;
}

async function electronFuseInfo(appPath) {
  const frameworkPath = join(appPath, FRAMEWORK_RELATIVE_PATH);
  const bytes = await readFile(frameworkPath);
  const first = bytes.indexOf(FUSE_SENTINEL);
  const second = first < 0 ? -1 : bytes.indexOf(FUSE_SENTINEL, first + FUSE_SENTINEL.length);
  if (first < 0 || second >= 0) fail(`Electron fuse 标记应恰好匹配 1 处，实际为 ${first < 0 ? 0 : 2}`);
  const versionOffset = first + FUSE_SENTINEL.length;
  const version = bytes[versionOffset];
  const count = bytes[versionOffset + 1];
  if (version !== 1 || count <= ONLY_LOAD_APP_FROM_ASAR_FUSE_INDEX || versionOffset + 2 + count > bytes.length) {
    fail(`Electron fuse wire 格式不受支持：version=${version ?? "none"}, count=${count ?? "none"}`);
  }
  const values = bytes.subarray(versionOffset + 2, versionOffset + 2 + count);
  if (![...values].every((value) => value === 0x30 || value === 0x31 || value === 0x72)) {
    fail("Electron fuse wire 包含未知状态");
  }
  const state = (index) => values[index] === 0x31 ? "enabled" : values[index] === 0x30 ? "disabled" : "removed";
  return {
    frameworkPath,
    frameworkBytes: bytes,
    version,
    count,
    embeddedAsarIntegrityValidation: state(EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX),
    onlyLoadAppFromAsar: state(ONLY_LOAD_APP_FROM_ASAR_FUSE_INDEX),
  };
}

function inspectEntitlementSigningTargets(appPath) {
  const present = APERITIF_ENTITLEMENT_SIGNING_TARGETS.filter((relative) => existsSync(join(appPath, relative)));
  if (present.length !== 0 && present.length !== APERITIF_ENTITLEMENT_SIGNING_TARGETS.length) {
    fail("Aperitif 签名组件不完整；必须全部存在或全部不存在");
  }
  return [...ENTITLEMENT_SIGNING_TARGETS, ...present];
}

async function signatureInfo(appPath) {
  const targets = [...inspectNativeSigningTargets(appPath), ...inspectEntitlementSigningTargets(appPath), ...EXECUTABLE_SIGNING_TARGETS, ...CONTAINER_SIGNING_TARGETS]
    .map((relative) => join(appPath, relative));
  const [verifications, details] = await Promise.all([
    Promise.all([
      runAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], { allowFailure: true })
        .then((result) => ({ target: appPath, result })),
      ...targets.map((target) => runAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", target], { allowFailure: true })
        .then((result) => ({ target, result }))),
    ]),
    runAsync("/usr/bin/codesign", ["-d", "-r-", "--verbose=2", appPath], { allowFailure: true }),
  ]);
  const failed = verifications.filter(({ result }) => result.status !== 0);
  const output = `${details.stdout}\n${details.stderr}`;
  return {
    valid: failed.length === 0,
    verifyMessage: failed.map(({ target, result }) => `${target}: ${(result.stderr || result.stdout || "签名校验失败").trim()}`).join("\n"),
    designatedRequirement: output.match(/designated => ([^\n]+)/)?.[1] ?? null,
    teamIdentifier: output.match(/TeamIdentifier=([^\n]+)/)?.[1] ?? null,
  };
}

function hasExpectedSigningTargets(appPath) {
  return [...inspectEntitlementSigningTargets(appPath), ...EXECUTABLE_SIGNING_TARGETS, ...CONTAINER_SIGNING_TARGETS]
    .every((relative) => existsSync(join(appPath, relative)));
}

function asarIntegrityCompatible(inspection) {
  const entry = inspection.structure?.entryIntegrity;
  if (inspection.fuses.embeddedAsarIntegrityValidation === "disabled") {
    if (!entry?.present || entry.valid) return true;
    // With the Fuse disabled, an applied patch intentionally leaves the
    // original file-table hash stale; reject the same state before patching.
    return inspection.structure?.analysis?.marker != null;
  }
  return inspection.fuses.embeddedAsarIntegrityValidation === "enabled"
    && entry?.present === true
    && entry.valid === true;
}

export function isRepairableUpdatedSignature(inspection) {
  const requirement = inspection.signature.designatedRequirement ?? "";
  return !inspection.signature.valid
    && inspection.signature.verifyMessage.includes("invalid signature")
    && inspection.bundleSupported
    && !inspection.structureError
    && inspection.structure?.analysis.status === "ready"
    && asarIntegrityCompatible(inspection)
    && inspection.actualIntegrityHash === inspection.recordedHash
    && inspection.frameworkIntegrityDigest.valid
    && inspection.signature.teamIdentifier === OFFICIAL_TEAM_IDENTIFIER
    && requirement.includes(`identifier "${inspection.bundleIdentifier}"`)
    && requirement.includes("anchor apple generic")
    && requirement.includes(`certificate leaf[subject.OU] = "${OFFICIAL_TEAM_IDENTIFIER}"`)
    && hasExpectedSigningTargets(inspection.appPath);
}

export async function inspectApp(appPath) {
  const resolved = resolve(appPath);
  const asarPath = join(resolved, "Contents/Resources/app.asar");
  const plistPath = join(resolved, "Contents/Info.plist");
  const [asar, plist, fuses] = await Promise.all([
    readFile(asarPath),
    readFile(plistPath),
    electronFuseInfo(resolved),
  ]);
  const identity = plistIdentity(plistPath);
  const actualHash = sha256(asar);
  const actualIntegrityHash = asarIntegrityHash(asar);
  const recordedHash = plistRead(plistPath, INTEGRITY_KEY);
  const frameworkIntegrityDigest = inspectFrameworkIntegrityDigest(fuses.frameworkBytes, recordedHash);
  let structure;
  let structureError = null;
  try {
    structure = inspectAsarBuffer(asar);
  } catch (error) {
    structureError = error.message;
  }
  const signature = await signatureInfo(resolved);
  const inspection = {
    appPath: resolved,
    asarPath,
    plistPath,
    asar,
    plist,
    ...identity,
    actualHash,
    actualIntegrityHash,
    recordedHash,
    structure,
    structureError,
    signature,
    fuses,
    frameworkIntegrityDigest,
    versionSupported: SUPPORTED_APP_VERSIONS.includes(identity.version),
    versionVerified: VERIFIED_APP_VERSIONS.includes(identity.version),
    bundleSupported: SUPPORTED_BUNDLE_IDENTIFIERS.includes(identity.bundleIdentifier),
    healthy: !structureError
      && actualIntegrityHash === recordedHash
      && asarIntegrityCompatible({ fuses, structure })
      && frameworkIntegrityDigest.valid
      && signature.valid,
  };
  inspection.repairableUpdatedSignature = isRepairableUpdatedSignature(inspection);
  return inspection;
}

export function assertSupportedTarget(inspection) {
  const problems = [];
  if (!inspection.bundleSupported) problems.push(`Bundle ID ${inspection.bundleIdentifier} 不受支持`);
  if (problems.length) fail(`发行兼容性检查失败：\n- ${problems.join("\n- ")}`);
}

export function assertHealthy(inspection, expectedStatus = null, { allowUpdatedSignature = false } = {}) {
  const problems = [];
  if (inspection.structureError) problems.push(`补丁结构：${inspection.structureError}`);
  if (!asarIntegrityCompatible(inspection)) {
    problems.push(`Electron ASAR 内容完整性 fuse 状态为 ${inspection.fuses.embeddedAsarIntegrityValidation}，且目标分包整体或分块哈希不可验证；仅支持对完整元数据执行等长更新`);
  }
  if (inspection.structure?.analysis.marker == null && inspection.structure?.entryIntegrity.present && !inspection.structure.entryIntegrity.valid) {
    problems.push(`目标分包完整性：${inspection.structure.entryIntegrity.reason}`);
  }
  if (inspection.actualIntegrityHash !== inspection.recordedHash) problems.push("ASAR 头部完整性与 Info.plist 不一致；请重新安装官方客户端，不要强行应用补丁");
  if (!inspection.frameworkIntegrityDigest.valid) problems.push("Framework 内嵌 ASAR 完整性摘要与 Info.plist 不一致；客户端可能无法启动");
  if (!inspection.signature.valid && !(allowUpdatedSignature && inspection.repairableUpdatedSignature)) {
    problems.push(`代码签名无效：${inspection.signature.verifyMessage || "无详情"}；请重新安装官方客户端，或仅在确认这是本工具补丁后的自动升级版本时使用 --allow-updated-signature`);
  }
  if (expectedStatus && inspection.structure?.analysis.status !== expectedStatus) {
    problems.push(`补丁状态应为 ${expectedStatus}，实际为 ${inspection.structure?.analysis.status ?? "unknown"}`);
  }
  if (problems.length) fail(`客户端健康检查失败：\n- ${problems.join("\n- ")}`);
}

export async function atomicWrite(path, bytes) {
  const metadata = await stat(path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", metadata.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    });
    throw error;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function acquireLock(appPath, directory = tmpdir()) {
  const key = sha256(resolve(appPath)).slice(0, 24);
  const path = join(directory, `${TOOL_NAME}-${key}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), appPath: resolve(appPath) }));
      await handle.sync();
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8"));
          if (current.token === token) await unlink(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch (readError) {
        fail(`补丁锁已存在且内容损坏：${path}（${readError.message}）`);
      }
      if (Number.isInteger(existing.pid) && pidAlive(existing.pid)) fail(`已有补丁进程正在操作此客户端（PID ${existing.pid}）`);
      if (attempt === 0) await unlink(path);
    }
  }
  fail("无法取得补丁互斥锁");
}

export async function transactionalWrite({ asarPath, plistPath, frameworkPath, nextAsar, nextPlist, nextFramework, originalAsar, originalPlist, originalFramework, commit, rollbackCommit }) {
  let liveWriteStarted = false;
  try {
    liveWriteStarted = true;
    await atomicWrite(asarPath, nextAsar);
    await atomicWrite(plistPath, nextPlist);
    if (nextFramework) await atomicWrite(frameworkPath, nextFramework);
    return await commit();
  } catch (error) {
    if (!liveWriteStarted) throw error;
    try {
      await atomicWrite(asarPath, originalAsar);
      await atomicWrite(plistPath, originalPlist);
      if (originalFramework) await atomicWrite(frameworkPath, originalFramework);
      await rollbackCommit();
      error.rollback = { succeeded: true };
    } catch (rollbackError) {
      error.rollback = { succeeded: false, error: rollbackError };
    }
    throw error;
  }
}

export async function assertDiskCapacity(requirements) {
  const filesystems = new Map();
  for (const requirement of requirements) {
    const metadata = await stat(requirement.path);
    const key = String(metadata.dev);
    const current = filesystems.get(key) ?? { path: requirement.path, required: 0 };
    current.required += requirement.bytes;
    filesystems.set(key, current);
  }
  for (const filesystem of filesystems.values()) {
    const info = await statfs(filesystem.path);
    const available = Number(BigInt(info.bavail) * BigInt(info.bsize));
    if (!Number.isSafeInteger(available)) fail(`无法安全计算文件系统可用空间：${filesystem.path}`);
    if (available < filesystem.required) {
      const requiredMiB = Math.ceil(filesystem.required / 1024 / 1024);
      const availableMiB = Math.floor(available / 1024 / 1024);
      fail(`磁盘空间不足：${filesystem.path} 至少需要 ${requiredMiB} MiB，可用 ${availableMiB} MiB`);
    }
  }
}

export async function sanitizedEntitlements(target, directory, index) {
  const display = await runAsync("/usr/bin/codesign", ["-d", "--entitlements", ":-", target]);
  if (!display.stdout.includes("<plist")) fail(`无法读取签名权限：${target}`);
  const path = join(directory, `entitlements-${index}.plist`);
  await writeFile(path, display.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" });
  for (const key of RESTRICTED_ADHOC_ENTITLEMENTS) {
    const read = await runAsync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path], { allowFailure: true });
    if (read.status === 0) await runAsync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, path]);
    else if (!read.stderr.includes("Does Not Exist")) fail(`检查受限签名权限失败（${key}）：${read.stderr.trim()}`);
  }
  return path;
}

function signTarget(target, identity, entitlements = null) {
  const args = ["--force", "--sign", identity, "--preserve-metadata=flags,runtime"];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  console.log(`签名组件: ${target}`);
  run("/usr/bin/codesign", args);
}

export function signNativeModule(target, identity) {
  signTarget(target, identity);
  const display = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", target]);
  if (display.stdout.trim() && (!display.stdout.includes("<plist") || display.stdout.includes("<key>"))) fail(`原生库重签后仍包含权限：${target}`);
  run("/usr/bin/codesign", ["--verify", "--strict", target]);
}

async function signApp(appPath, identity) {
  const resolved = resolve(appPath);
  const directory = mkdtempSync(join(tmpdir(), "codex-quota-card-sign-"));
  try {
    const nativeTargets = inspectNativeSigningTargets(resolved);
    const entitlementTargets = inspectEntitlementSigningTargets(resolved).map((relative, index) => ({
      relative,
      target: join(resolved, relative),
      index,
    }));
    const allEntitlementTargets = [...entitlementTargets, { relative: ".", target: resolved, index: "app" }];
    const signingTargets = [
      ...entitlementTargets,
      ...EXECUTABLE_SIGNING_TARGETS.map((relative) => ({ relative, target: join(resolved, relative) })),
      ...CONTAINER_SIGNING_TARGETS.map((relative) => ({ relative, target: join(resolved, relative) })),
      { relative: ".", target: resolved },
    ];
    for (const { relative, target } of signingTargets) {
      if (!existsSync(target)) fail(`签名目标缺失：${relative}`);
    }

    const preparedEntitlements = await Promise.allSettled(
      allEntitlementTargets.map(({ target, index }) => sanitizedEntitlements(target, directory, index)),
    );
    const failedEntitlement = preparedEntitlements.find((result) => result.status === "rejected");
    if (failedEntitlement) throw failedEntitlement.reason;
    const entitlementPaths = preparedEntitlements.map((result) => result.value);

    for (const relative of nativeTargets) signNativeModule(join(resolved, relative), identity);
    for (const [index, { target }] of entitlementTargets.entries()) {
      signTarget(target, identity, entitlementPaths[index]);
    }
    const entitlementCount = entitlementTargets.length;
    const executableEnd = entitlementCount + EXECUTABLE_SIGNING_TARGETS.length;
    for (const { target } of signingTargets.slice(entitlementCount, executableEnd)) {
      signTarget(target, identity);
    }
    for (const { target } of signingTargets.slice(executableEnd, -1)) {
      signTarget(target, identity);
    }
    signTarget(resolved, identity, entitlementPaths.at(-1));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function signAndVerify(appPath, identity) {
  await signApp(appPath, identity);
  const verify = await signatureInfo(appPath);
  if (!verify.valid) fail(`签名后的深度校验失败：${verify.verifyMessage || "无详情"}`);
}

async function rollbackAndVerify(appPath, identity, asarPath, plistPath, frameworkPath, originalAsar, originalPlist, originalFramework) {
  await signAndVerify(appPath, identity);
  const [asar, plist, framework] = await Promise.all([readFile(asarPath), readFile(plistPath), readFile(frameworkPath)]);
  if (sha256(asar) !== sha256(originalAsar) || sha256(plist) !== sha256(originalPlist)) fail("自动回滚后的文件哈希与原始快照不一致");
  if (sha256(framework) !== sha256(originalFramework)) fail("自动回滚后的 Framework 与原始快照不一致");
}

function assertAppNotRunning(appPath) {
  const resolved = resolve(appPath);
  const executableName = plistRead(join(resolved, "Contents/Info.plist"), ":CFBundleExecutable");
  const executable = join(resolved, "Contents/MacOS", executableName);
  const result = run("/usr/bin/pgrep", ["-f", executable], { allowFailure: true });
  if (result.status === 0 && result.stdout.trim()) fail("Codex App 仍在运行。请先按 Command+Q 完全退出，再重试");
  if (result.status !== 0 && result.status !== 1) fail(`无法确认客户端运行状态：${result.stderr.trim()}`);
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function createBackup(inspection, backupRoot) {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeVersion = inspection.version.replace(/[^A-Za-z0-9._-]/g, "_");
  const finalPath = join(resolve(backupRoot), `${safeVersion}-${timestamp}`);
  const staging = join(resolve(backupRoot), `.pending-${process.pid}-${randomUUID()}`);
  const asarName = "app.asar";
  const plistName = "Info.plist";
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    tool: TOOL_NAME,
    createdAt: new Date().toISOString(),
    appPath: inspection.appPath,
    bundleIdentifier: inspection.bundleIdentifier,
    version: inspection.version,
    targetPath: "Contents/Resources/app.asar",
    sourceStatus: inspection.structure.analysis.status,
    sourceMarker: inspection.structure.analysis.marker,
    asar: { file: asarName, sha256: sha256(inspection.asar), size: inspection.asar.length },
    plist: { file: plistName, sha256: sha256(inspection.plist), size: inspection.plist.length },
  };
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await Promise.all([
      copyFile(inspection.asarPath, join(staging, asarName)),
      copyFile(inspection.plistPath, join(staging, plistName)),
    ]);
    await Promise.all([
      chmod(join(staging, asarName), 0o600),
      chmod(join(staging, plistName), 0o600),
    ]);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await validateBackup(staging, inspection);
    await rename(staging, finalPath);
    await fsyncDirectory(resolve(backupRoot));
    return finalPath;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch((cleanupError) => { error.cleanupError = cleanupError; });
    throw error;
  }
}

function validateManifestShape(manifest) {
  if (manifest.manifestVersion !== MANIFEST_VERSION || manifest.tool !== TOOL_NAME) fail("备份清单版本不受支持；仅接受本工具生成的 v2 清单");
  if (manifest.targetPath !== "Contents/Resources/app.asar") fail("备份目标路径无效");
  for (const key of ["bundleIdentifier", "version"]) if (typeof manifest[key] !== "string" || !manifest[key]) fail(`备份清单缺少 ${key}`);
  for (const key of ["asar", "plist"]) {
    const value = manifest[key];
    if (!value || typeof value.file !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.file) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1) fail(`备份清单 ${key} 字段无效`);
  }
}

export async function validateBackup(backupPath, destination = null) {
  const root = resolve(backupPath);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); }
  catch (error) { fail(`备份清单无法读取：${error.message}`); }
  validateManifestShape(manifest);
  const asarPath = join(root, manifest.asar.file);
  const plistPath = join(root, manifest.plist.file);
  const [asar, plist] = await Promise.all([readFile(asarPath), readFile(plistPath)]);
  for (const [key, bytes] of [["asar", asar], ["plist", plist]]) {
    if (bytes.length !== manifest[key].size || sha256(bytes) !== manifest[key].sha256) fail(`备份 ${key} 的大小或哈希校验失败`);
  }
  const backupIdentity = plistIdentity(plistPath);
  if (backupIdentity.bundleIdentifier !== manifest.bundleIdentifier || backupIdentity.version !== manifest.version) fail("备份 Info.plist 与清单身份不一致");
  if (destination && (destination.bundleIdentifier !== manifest.bundleIdentifier || destination.version !== manifest.version)) fail("备份与目标客户端的 Bundle ID 或版本不匹配");
  inspectAsarBuffer(asar);
  const integrityHash = asarIntegrityHash(asar);
  const recordedIntegrityHash = plistRead(plistPath, INTEGRITY_KEY);
  if (integrityHash !== recordedIntegrityHash) fail("备份 ASAR 头部完整性与备份 Info.plist 不一致");
  return { manifest, asar, plist, asarPath, plistPath, integrityHash, recordedIntegrityHash };
}

function assertUnchanged(before, currentAsar, currentPlist, currentFramework) {
  if (sha256(currentAsar) !== sha256(before.asar)
    || sha256(currentPlist) !== sha256(before.plist)
    || sha256(currentFramework) !== sha256(before.fuses.frameworkBytes)) {
    fail("写入前检测到客户端文件发生变化，已中止以避免竞态覆盖");
  }
}

async function applyPatch(options) {
  const release = await acquireLock(options.app);
  let backupPath = null;
  try {
    assertAppNotRunning(options.app);
    const before = await inspectApp(options.app);
    assertSupportedTarget(before);
    assertHealthy(before, null, { allowUpdatedSignature: options.allowUpdatedSignature });
    if (!before.signature.valid) {
      console.log("签名处理: 已确认补丁后自动升级状态；事务提交时将重新建立完整的本机签名链");
    }
    if (before.structure.analysis.status === "already-patched") {
      console.log("状态: already-patched（结构、完整性哈希和签名均有效）");
      return;
    }
    const rewriteIntegrity = before.fuses.embeddedAsarIntegrityValidation === "enabled";
    const patched = patchAsarBuffer(before.asar, { rewriteIntegrity });
    const nextHash = sha256(patched.buffer);
    const nextIntegrityHash = asarIntegrityHash(patched.buffer);
    if (!rewriteIntegrity && nextIntegrityHash !== before.actualIntegrityHash) fail("等长补丁意外改变了 ASAR 头部完整性哈希");
    const nextPlist = rewriteIntegrity
      ? updatePlistIntegrityHash(before.plist, before.recordedHash, nextIntegrityHash)
      : before.plist;
    const nextFramework = rewriteIntegrity && before.frameworkIntegrityDigest.used
      ? patchFrameworkIntegrityDigest(before.fuses.frameworkBytes, before.frameworkIntegrityDigest, nextIntegrityHash)
      : null;
    await mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
    await assertDiskCapacity([
      { path: dirname(before.asarPath), bytes: before.asar.length + DISK_SAFETY_BYTES },
      ...(nextFramework ? [{ path: dirname(before.fuses.frameworkPath), bytes: nextFramework.length }] : []),
      { path: resolve(options.backupRoot), bytes: before.asar.length + before.plist.length + DISK_SAFETY_BYTES },
    ]);
    backupPath = await createBackup(before, options.backupRoot);
    const [currentAsar, currentPlist, currentFramework] = await Promise.all([
      readFile(before.asarPath), readFile(before.plistPath), readFile(before.fuses.frameworkPath),
    ]);
    assertUnchanged(before, currentAsar, currentPlist, currentFramework);
    const after = await transactionalWrite({
      asarPath: before.asarPath,
      plistPath: before.plistPath,
      frameworkPath: before.fuses.frameworkPath,
      nextAsar: patched.buffer,
      nextPlist,
      nextFramework,
      originalAsar: before.asar,
      originalPlist: before.plist,
      originalFramework: nextFramework ? before.fuses.frameworkBytes : null,
      commit: async () => {
        await signApp(before.appPath, options.signIdentity);
        const committed = await inspectApp(options.app);
        assertHealthy(committed, "already-patched");
        if (committed.asar.length !== before.asar.length || committed.actualHash !== nextHash) fail("应用后的最终文件校验失败");
        return committed;
      },
      rollbackCommit: async () => rollbackAndVerify(before.appPath, options.signIdentity, before.asarPath, before.plistPath, before.fuses.frameworkPath, before.asar, before.plist, before.fuses.frameworkBytes),
    });
    console.log(`状态: applied\n版本: ${after.version}\nASAR: ${before.actualHash} -> ${after.actualHash}\n备份: ${backupPath}\n签名: ${options.signIdentity === "-" ? "临时签名" : options.signIdentity}`);
  } catch (error) {
    if (backupPath) error.message += `\n备份: ${backupPath}`;
    if (error.rollback) error.message += error.rollback.succeeded ? "\n自动回滚: 成功" : `\n自动回滚: 失败（${error.rollback.error.message}）`;
    throw error;
  } finally {
    await release();
  }
}

async function restoreBackup(options) {
  if (!options.backup) fail("restore 必须提供 --backup <目录>");
  const release = await acquireLock(options.app);
  try {
    assertAppNotRunning(options.app);
    const before = await inspectApp(options.app);
    assertSupportedTarget(before);
    const backup = await validateBackup(options.backup, before);
    const restoredPlist = backup.plist;
    const restoredFramework = before.frameworkIntegrityDigest.used
      ? patchFrameworkIntegrityDigest(before.fuses.frameworkBytes, before.frameworkIntegrityDigest, backup.recordedIntegrityHash)
      : null;
    await assertDiskCapacity([
      { path: dirname(before.asarPath), bytes: Math.max(before.asar.length, backup.asar.length) + DISK_SAFETY_BYTES },
      ...(restoredFramework ? [{ path: dirname(before.fuses.frameworkPath), bytes: restoredFramework.length }] : []),
    ]);
    const [currentAsar, currentPlist, currentFramework] = await Promise.all([
      readFile(before.asarPath), readFile(before.plistPath), readFile(before.fuses.frameworkPath),
    ]);
    assertUnchanged(before, currentAsar, currentPlist, currentFramework);
    const after = await transactionalWrite({
      asarPath: before.asarPath,
      plistPath: before.plistPath,
      frameworkPath: before.fuses.frameworkPath,
      nextAsar: backup.asar,
      nextPlist: restoredPlist,
      nextFramework: restoredFramework,
      originalAsar: before.asar,
      originalPlist: before.plist,
      originalFramework: restoredFramework ? before.fuses.frameworkBytes : null,
      commit: async () => {
        await signApp(before.appPath, options.signIdentity);
        const committed = await inspectApp(options.app);
        assertHealthy(committed);
        if (committed.actualHash !== backup.manifest.asar.sha256) fail("恢复后的 ASAR 与备份不一致");
        return committed;
      },
      rollbackCommit: async () => rollbackAndVerify(before.appPath, options.signIdentity, before.asarPath, before.plistPath, before.fuses.frameworkPath, before.asar, before.plist, before.fuses.frameworkBytes),
    });
    console.log(`状态: restored\n补丁状态: ${after.structure.analysis.status}\nASAR: ${before.actualHash} -> ${after.actualHash}\n来源: ${resolve(options.backup)}`);
  } finally {
    await release();
  }
}

async function validateBackupCli(options) {
  if (!options.backup) fail("validate-backup 必须提供 --backup <目录>");
  const resolvedApp = resolve(options.app);
  const destination = plistIdentity(join(resolvedApp, "Contents/Info.plist"));
  if (!SUPPORTED_BUNDLE_IDENTIFIERS.includes(destination.bundleIdentifier)) fail(`Bundle ID ${destination.bundleIdentifier} 不受支持`);
  const backup = await validateBackup(options.backup, destination);
  console.log(`备份校验: 通过\n版本: ${backup.manifest.version}\n状态: ${backup.manifest.sourceStatus}\nASAR SHA-256: ${backup.manifest.asar.sha256}\n创建时间: ${backup.manifest.createdAt}`);
}

function printInspection(inspection, options) {
  const semanticCompatible = inspection.bundleSupported
    && !inspection.structureError
    && asarIntegrityCompatible(inspection)
    && inspection.actualIntegrityHash === inspection.recordedHash
    && inspection.frameworkIntegrityDigest.valid;
  console.log([
    `应用: ${inspection.appPath}`,
    `版本: ${inspection.version}`,
    `Bundle ID: ${inspection.bundleIdentifier}`,
    `状态: ${inspection.structure?.analysis.status ?? "invalid"}`,
    `目标分包: ${inspection.structure?.file.path ?? "无法识别"}`,
    `补丁标记: ${inspection.structure?.analysis.marker ?? "none"}`,
    `收起态浮动挂载: ${inspection.structure?.analysis.mountContract?.collapsedCall ? "待禁用" : inspection.structure?.analysis.mountContract?.collapsedMountDisabled ? "已禁用" : "不存在"}`,
    `ASAR 文件 SHA-256: ${inspection.actualHash}`,
    `ASAR 头部完整性: ${inspection.actualIntegrityHash}`,
    `Info.plist 记录: ${inspection.recordedHash}`,
    `完整性一致: ${inspection.actualIntegrityHash === inspection.recordedHash ? "是" : "否"}`,
    `Framework 内嵌完整性摘要: ${inspection.frameworkIntegrityDigest.present ? inspection.frameworkIntegrityDigest.used ? inspection.frameworkIntegrityDigest.valid ? "匹配" : "不匹配" : "未启用" : "不存在"}`,
    `目标分包内容哈希: ${inspection.structure?.entryIntegrity.present ? inspection.structure.analysis.marker ? inspection.structure.entryIntegrity.valid ? "补丁内容匹配" : "补丁后哈希不匹配" : inspection.structure.entryIntegrity.valid ? "原始内容匹配" : "不匹配" : "无记录"}`,
    `ASAR 内容完整性 Fuse: ${inspection.fuses.embeddedAsarIntegrityValidation}`,
    `仅从 ASAR 加载 Fuse: ${inspection.fuses.onlyLoadAppFromAsar}`,
    `深度签名有效: ${inspection.signature.valid ? "是" : "否"}`,
    `升级后重签资格: ${inspection.repairableUpdatedSignature ? "符合" : "不符合"}`,
    `版本验证记录: ${inspection.versionVerified ? "已验证" : `新版本（参考记录：${VERIFIED_APP_VERSIONS.join(", ")}）`}`,
    `语义兼容: ${semanticCompatible ? "通过" : "未通过"}`,
    `发行兼容: ${semanticCompatible ? inspection.versionVerified ? "已验证" : "自动验证通过" : "未验证"}`,
    `签名要求: ${inspection.signature.designatedRequirement ?? "不可用"}`,
    `Team ID: ${inspection.signature.teamIdentifier ?? "none"}`,
  ].join("\n"));
  assertSupportedTarget(inspection);
  assertHealthy(inspection, null, { allowUpdatedSignature: options.allowUpdatedSignature });
}

function parseArguments(argv) {
  const action = argv[0];
  if (!["check", "apply", "restore", "validate-backup"].includes(action)) fail("用法: patch-codex-quota-card.mjs <check|apply|restore|validate-backup> [--app PATH] [--backup-root PATH] [--backup PATH] [--sign-identity ID] [--allow-updated-signature]");
  const options = { action, app: DEFAULT_APP, backupRoot: join(PROJECT_ROOT, "backups"), backup: null, signIdentity: "-", allowUpdatedSignature: false };
  const allowed = new Map([["--app", "app"], ["--backup-root", "backupRoot"], ["--backup", "backup"], ["--sign-identity", "signIdentity"]]);
  for (let index = 1; index < argv.length;) {
    if (argv[index] === "--allow-updated-signature") {
      options.allowUpdatedSignature = true;
      index += 1;
      continue;
    }
    const key = allowed.get(argv[index]);
    if (!key) fail(`未知参数: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argv[index]} 缺少参数值`);
    options[key] = value;
    index += 2;
  }
  if (!["restore", "validate-backup"].includes(action) && options.backup) fail("--backup 仅适用于 restore 或 validate-backup");
  if (action === "check" && (options.backup || options.signIdentity !== "-" || options.backupRoot !== join(PROJECT_ROOT, "backups"))) fail("check 仅接受 --app");
  if (!["check", "apply"].includes(action) && options.allowUpdatedSignature) fail("--allow-updated-signature 仅适用于 check 或 apply");
  if (action === "validate-backup" && (options.signIdentity !== "-" || options.backupRoot !== join(PROJECT_ROOT, "backups"))) fail("validate-backup 仅接受 --app 和 --backup");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.action === "check") printInspection(await inspectApp(options.app), options);
  else if (options.action === "apply") await applyPatch(options);
  else if (options.action === "restore") await restoreBackup(options);
  else await validateBackupCli(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}
