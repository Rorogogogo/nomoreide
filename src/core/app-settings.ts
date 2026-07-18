import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export interface AppSettings {
  version: 1;
  terminal: {
    fontSize: number;
    cursorStyle: "block" | "underline" | "bar";
    scrollback: number;
    copyOnSelect: boolean;
    confirmTerminate: boolean;
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  version: 1,
  terminal: Object.freeze({
    fontSize: 13,
    cursorStyle: "block",
    scrollback: 5_000,
    copyOnSelect: false,
    confirmTerminate: true,
  }),
});

const appSettingsSchema: z.ZodType<AppSettings> = z.object({
  version: z.literal(1),
  terminal: z.object({
    fontSize: z.number().int().min(10).max(24),
    cursorStyle: z.enum(["block", "underline", "bar"]),
    scrollback: z.number().int().min(500).max(100_000),
    copyOnSelect: z.boolean(),
    confirmTerminate: z.boolean(),
  }),
});

export interface AppSettingsPatch {
  version?: 1;
  terminal?: Partial<AppSettings["terminal"]>;
}

export function defaultAppSettingsPath(): string {
  const configuredRoot = process.env.XDG_CONFIG_HOME?.trim();
  const configRoot = configuredRoot || join(homedir(), ".config");
  return join(configRoot, "nomoreide", "settings.json");
}

export class AppSettingsStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly settingsPath = defaultAppSettingsPath()) {}

  async load(): Promise<AppSettings> {
    try {
      const contents = await readFile(this.settingsPath, "utf8");
      return cloneSettings(appSettingsSchema.parse(JSON.parse(contents)));
    } catch (error) {
      if (isMissingFileError(error)) {
        return cloneSettings(DEFAULT_APP_SETTINGS);
      }
      throw error;
    }
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    return this.enqueueMutation(async () => {
      const current = await this.load();
      const next = appSettingsSchema.parse({
        ...current,
        ...patch,
        terminal: {
          ...current.terminal,
          ...patch.terminal,
        },
      });

      await this.persist(next);
      return cloneSettings(next);
    });
  }

  async reset(): Promise<AppSettings> {
    return this.enqueueMutation(async () => {
      const defaults = cloneSettings(DEFAULT_APP_SETTINGS);
      await this.persist(defaults);
      return cloneSettings(defaults);
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(settings: AppSettings): Promise<void> {
    const validated = appSettingsSchema.parse(settings);
    const parentDirectory = dirname(this.settingsPath);
    const temporaryPath = join(
      parentDirectory,
      `.${basename(this.settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    await mkdir(parentDirectory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { flag: "wx" },
      );
      await rename(temporaryPath, this.settingsPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function cloneSettings(settings: AppSettings): AppSettings {
  return structuredClone(settings);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
