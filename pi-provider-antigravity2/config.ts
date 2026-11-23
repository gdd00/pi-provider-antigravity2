import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { DEFAULT_USER_AGENT } from "./constants.ts";

export const ANSI_FG_RESET = "\x1b[39m";
export const PROVIDER_CONFIG_FILE = "pi-provider-antigravity.json";

export interface ProviderFileConfig {
  oauthClientId?: string;
  oauthClientSecret?: string;
  userAgent?: string;
  settings?: { [key: string]: unknown };
  states?: { [name: string]: { [key: string]: unknown } | undefined };
}

export interface SettingsUiDeps {
  createSettingsList?: (
    items: SettingItem[],
    maxVisible: number,
    theme: SettingsListTheme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) => {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    updateValue(id: string, newValue: string): void;
  };
  getSettingsListTheme?: () => SettingsListTheme;
}

/**
 * Resolves Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 */
export function getAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  agentDirOverride?: string,
): string {
  const raw = (agentDirOverride && agentDirOverride.trim()) || (env.PI_CODING_AGENT_DIR || "").trim();
  if (raw) {
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      return path.join(os.homedir(), raw.slice(2));
    }
    return raw;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Resolves the config file path inside Pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 */
export function defaultConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  agentDirOverride?: string,
): string {
  return path.join(getAgentDir(env, agentDirOverride), PROVIDER_CONFIG_FILE);
}

/**
 * Loads and parses the provider JSON configuration file, returning undefined if absent or invalid.
 */
export function loadProviderConfig(file = defaultConfigFile()): ProviderFileConfig | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as ProviderFileConfig;
    }
  } catch {
    // Missing or unreadable config means unconfigured defaults.
  }
  return undefined;
}

/** Resolves a local HTTP User-Agent override, ignoring unusable header values. */
export function resolveAntigravityUserAgent(file = defaultConfigFile()): string {
  const value = loadProviderConfig(file)?.userAgent;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : DEFAULT_USER_AGENT;
}

/**
 * Atomically writes JSON, preserving existing permissions unless a mode is supplied.
 */
export function writeJsonAtomically(file: string, data: unknown, mode?: number): boolean {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existingMode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
    const fd = fs.openSync(tmp, "wx", mode ?? existingMode);
    try {
      if (mode !== undefined) fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing left to clean up.
    }
    return false;
  }
}

export function writeProviderConfigAtomically(file: string, data: ProviderFileConfig): boolean {
  return writeJsonAtomically(file, data, data.oauthClientSecret ? 0o600 : undefined);
}

/**
 * Atomically updates keys inside the provider JSON file while preserving unrelated keys.
 */
export function updateProviderConfig(
  file: string,
  mutate: (config: ProviderFileConfig) => void,
): boolean {
  try {
    let data: ProviderFileConfig = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      data = raw as ProviderFileConfig;
    } catch (err: any) {
      if (err?.code !== "ENOENT") return false;
    }
    mutate(data);
    return writeProviderConfigAtomically(file, data);
  } catch {
    return false;
  }
}

/**
 * Loads persisted state for a named subsystem (`states[subsystem]`).
 */
export function loadSubsystemState<T>(
  subsystem: string,
  file = defaultConfigFile(),
): T | undefined {
  const state = loadProviderConfig(file)?.states?.[subsystem];
  return state && typeof state === "object" && !Array.isArray(state) ? (state as T) : undefined;
}

/**
 * Atomically merges state into `states[subsystem]` while keeping existing settings and states.
 */
export function saveSubsystemState<T extends object>(
  subsystem: string,
  state: T,
  file = defaultConfigFile(),
): boolean {
  return updateProviderConfig(file, (config) => {
    const states =
      config.states && typeof config.states === "object" && !Array.isArray(config.states)
        ? config.states
        : {};
    const current =
      states[subsystem] && typeof states[subsystem] === "object" && !Array.isArray(states[subsystem])
        ? states[subsystem]
        : {};
    states[subsystem] = { ...current, ...state };
    config.states = states;
  });
}

export interface SettingsFieldDef {
  key: string;
  label: string;
  description?: string;
  options: readonly string[];
  defaultValue?: string;
  optionNotes?: Record<string, string>;
  renderPreview?: (value: string, ctx: ExtensionCommandContext, theme?: Theme) => string | undefined;
  onChange?: (ctx: ExtensionCommandContext, value: string) => Promise<void>;
  prepare?: (ctx: ExtensionCommandContext) => Promise<void>;
}

/**
 * Returns the displayed current value for a setting field.
 */
export function fieldDisplayValue(
  config: ProviderFileConfig | undefined,
  field: SettingsFieldDef,
): string {
  const raw = config?.settings?.[field.key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return field.defaultValue ?? "unset";
}

/**
 * Persists a single setting field value into the config file.
 */
export function saveSettingValue(field: SettingsFieldDef, value: string, file: string): boolean {
  return updateProviderConfig(file, (config) => {
    const settings =
      config.settings && typeof config.settings === "object" && !Array.isArray(config.settings)
        ? config.settings
        : {};
    settings[field.key] = value;
    config.settings = settings;
  });
}

/**
 * Saves a setting field and invokes its `onChange` hook on success.
 */
export async function applySettingValue(
  field: SettingsFieldDef,
  value: string,
  file: string,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  if (!saveSettingValue(field, value, file)) {
    return false;
  }
  await field.onChange?.(ctx, value);
  return true;
}

function writeFailedMessage(file: string): string {
  return `Failed to write ${file}. If the file is not valid JSON, fix or delete it.`;
}

/**
 * Converts SettingsFieldDef entries into Pi TUI SettingItem records.
 */
export function buildSettingsItems(
  config: ProviderFileConfig | undefined,
  fields: readonly SettingsFieldDef[],
): SettingItem[] {
  return fields.map((f) => ({
    id: f.key,
    label: f.label,
    description: f.description,
    currentValue: fieldDisplayValue(config, f),
    values: [...f.options],
  }));
}

async function resolveSettingsListTheme(
  theme: Theme,
  uiDeps?: SettingsUiDeps,
): Promise<SettingsListTheme> {
  if (uiDeps?.getSettingsListTheme) {
    return uiDeps.getSettingsListTheme();
  }
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    if (typeof pi.getSettingsListTheme === "function") {
      return pi.getSettingsListTheme();
    }
  } catch {
    // Fallback below.
  }
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "-> "),
    hint: (text) => theme.fg("dim", text),
  };
}

/**
 * Opens interactive TUI or prompt-based settings selector for Antigravity fields.
 */
export async function openSettings(
  ctx: ExtensionCommandContext,
  fields: readonly SettingsFieldDef[],
  options?: { file?: string; uiDeps?: SettingsUiDeps },
): Promise<void> {
  const file = options?.file ?? defaultConfigFile();
  if (ctx.mode === "tui" && ctx.hasUI) {
    await openSettingsDialog(ctx, fields, file, options?.uiDeps);
    return;
  }

  const config = loadProviderConfig(file);
  if (!ctx.hasUI) {
    const text =
      fields.map((f) => `${f.label}: ${fieldDisplayValue(config, f)}`).join("\n") +
      `\nEdit ${file} to change.`;
    console.log(text);
    return;
  }

  let field = fields[0];
  if (!field) return;
  if (fields.length > 1) {
    const labels = fields.map((f) => `${f.label} (current: ${fieldDisplayValue(config, f)})`);
    const choice = await ctx.ui.select("Antigravity settings", labels);
    if (!choice) return;
    const found = fields[labels.indexOf(choice)];
    if (!found) return;
    field = found;
  }

  const picked = await ctx.ui.select(
    `${field.label} (current: ${fieldDisplayValue(config, field)})`,
    [...field.options],
  );
  if (!picked || !field.options.includes(picked)) return;

  if (await applySettingValue(field, picked, file, ctx)) {
    ctx.ui.notify(`${field.label} set to ${picked}.`, "info");
  } else {
    ctx.ui.notify(writeFailedMessage(file), "error");
  }
}

async function openSettingsDialog(
  ctx: ExtensionCommandContext,
  fields: readonly SettingsFieldDef[],
  file: string,
  uiDeps?: SettingsUiDeps,
): Promise<void> {
  let createSettingsList = uiDeps?.createSettingsList;
  if (!createSettingsList) {
    const { SettingsList } = await import("@earendil-works/pi-tui");
    createSettingsList = (items, maxVisible, themeObj, onChange, onCancel) =>
      new SettingsList(items, maxVisible, themeObj, onChange, onCancel);
  }

  await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
    const config = loadProviderConfig(file);
    const items = buildSettingsItems(config, fields);
    const prepared = fields.map((field) => field.prepare?.(ctx));

    const paintPreview = (field: SettingsFieldDef, value: string) => {
      const item = items.find((i) => i.id === field.key);
      if (!item) return;
      const base = field.description ?? "";
      const sample = field.renderPreview?.(value, ctx, theme);
      const head = sample && base ? `${base}: ${sample}` : (sample ?? base);
      const note = field.optionNotes?.[value];
      item.description = note ? `${head}\n\n${value}: ${note}` : head;
    };

    for (const field of fields) {
      paintPreview(field, fieldDisplayValue(config, field));
    }

    const listTheme = await resolveSettingsListTheme(theme, uiDeps);
    const list = createSettingsList!(
      items,
      Math.min(items.length, 10),
      listTheme,
      (id, newValue) => {
        const field = fields.find((f) => f.key === id);
        if (!field) return;
        list.invalidate();
        tui.requestRender();
        void applySettingValue(field, newValue, file, ctx).then((saved) => {
          if (!saved) {
            list.updateValue(field.key, fieldDisplayValue(loadProviderConfig(file), field));
            ctx.ui.notify(writeFailedMessage(file), "error");
            list.invalidate();
            tui.requestRender();
            return;
          }
          paintPreview(field, newValue);
          list.invalidate();
          tui.requestRender();
        });
      },
      () => done(),
    );

    fields.forEach((field, i) => {
      void prepared[i]
        ?.catch(() => {})
        .then(() => {
          const item = items.find((it) => it.id === field.key);
          if (item) paintPreview(field, item.currentValue);
          list.invalidate();
          tui.requestRender();
        });
    });

    const border = {
      render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    };

    return {
      render: (width: number) => [
        ...border.render(width),
        ...list.render(width),
        ...border.render(width),
      ],
      handleInput: (data: string) => list.handleInput(data),
      invalidate: () => list.invalidate(),
    };
  });
}

/**
 * Emits command output to Pi's UI notification toast or stdio when running headlessly.
 */
export function notifyCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
  } else if (type === "error" || type === "warning") {
    console.error(text);
  } else {
    console.log(text);
  }
}
