import { useCallback, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
import {
  getServiceConfigFile,
  getServiceConfigFiles,
  putServiceConfigFileEnv,
  putServiceConfigFileText,
  type ConfigFileInfo,
  type ServiceEnvEntry,
} from "@/lib/api";

export interface EnvRow extends ServiceEnvEntry {
  reveal: boolean;
}

export interface LoadedFile {
  info: ConfigFileInfo;
  exists: boolean;
  rows?: EnvRow[];
  text?: string;
}

export function prettyJson(text: string): string {
  if (!text.trim()) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Owns the Env tab's config-file state: the discovered file list, the
 * currently loaded file (env rows or raw text), and all mutations + saving.
 */
export function useServiceEnv(serviceName: string) {
  const { error: showError, success: showSuccess } = useToasts();
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<LoadedFile | undefined>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await getServiceConfigFiles(serviceName);
        if (cancelled) return;
        setFiles(result.files);
        if (result.files.length > 0) {
          setSelectedPath((current) => current ?? result.files[0].path);
        } else {
          setSelectedPath(undefined);
          setLoaded(undefined);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  const loadFile = useCallback(
    async (path: string) => {
      setLoadingFile(true);
      setError(undefined);
      try {
        const result = await getServiceConfigFile(serviceName, path);
        const info: ConfigFileInfo = {
          path: result.path,
          relativePath: result.relativePath,
          format: result.format,
        };
        if (result.format === "env") {
          setLoaded({
            info,
            exists: result.exists,
            rows: result.entries.map((entry) => ({ ...entry, reveal: false })),
          });
        } else {
          setLoaded({
            info,
            exists: result.exists,
            text: result.format === "json" ? prettyJson(result.content) : result.content,
          });
        }
        setDirty(false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoadingFile(false);
      }
    },
    [serviceName],
  );

  useEffect(() => {
    if (selectedPath) void loadFile(selectedPath);
  }, [selectedPath, loadFile]);

  function updateRow(index: number, patch: Partial<EnvRow>) {
    setLoaded((current) => {
      if (!current?.rows) return current;
      const rows = current.rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row));
      return { ...current, rows };
    });
    setDirty(true);
  }

  function addRow() {
    setLoaded((current) => {
      if (!current?.rows) return current;
      return {
        ...current,
        rows: [...current.rows, { key: "", value: "", secret: false, reveal: true }],
      };
    });
    setDirty(true);
  }

  function removeRow(index: number) {
    setLoaded((current) => {
      if (!current?.rows) return current;
      return { ...current, rows: current.rows.filter((_, idx) => idx !== index) };
    });
    setDirty(true);
  }

  function updateText(text: string) {
    setLoaded((current) => (current ? { ...current, text } : current));
    setDirty(true);
  }

  async function save() {
    if (!loaded) return;
    setSaving(true);
    try {
      if (loaded.info.format === "env" && loaded.rows) {
        const result = await putServiceConfigFileEnv(
          serviceName,
          loaded.info.path,
          loaded.rows.map((row) => ({ key: row.key.trim(), value: row.value })),
        );
        setLoaded({
          info: { path: result.path, relativePath: result.relativePath, format: result.format },
          exists: result.exists,
          rows: result.entries.map((entry) => ({ ...entry, reveal: false })),
        });
        showSuccess(`Saved ${result.entries.length} entries to ${result.relativePath}.`);
      } else if (loaded.text !== undefined) {
        const result = await putServiceConfigFileText(
          serviceName,
          loaded.info.path,
          loaded.text,
        );
        setLoaded({
          info: { path: result.path, relativePath: result.relativePath, format: result.format },
          exists: result.exists,
          text: result.content,
        });
        showSuccess(`Saved ${result.relativePath}.`);
      }
      setDirty(false);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function pickFile(relativePath: string): Promise<boolean> {
    try {
      const result = await getServiceConfigFile(serviceName, relativePath);
      const info: ConfigFileInfo = {
        path: result.path,
        relativePath: result.relativePath,
        format: result.format,
      };
      setFiles((current) =>
        current.some((file) => file.path === info.path) ? current : [...current, info],
      );
      setSelectedPath(info.path);
      showSuccess(`Loaded ${info.relativePath}.`);
      return true;
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  }

  return {
    files,
    selectedPath,
    setSelectedPath,
    loaded,
    loadingList,
    loadingFile,
    saving,
    dirty,
    error,
    addRow,
    removeRow,
    updateRow,
    updateText,
    save,
    pickFile,
  };
}
