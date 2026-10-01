import { MarkdownView, TFile, type App, type CachedMetadata, type Plugin } from "obsidian";
import { EmptyToggleError, LineChangedError, TasksMissingError } from "./lib/errors";
import { parseFileTasks, parseTaskLine, taskSource } from "./lib/parseTask";
import { ensureBlockId, locateLine, newBlockId, replaceLine } from "./lib/taskLine";
import { isOpen } from "./lib/taskList";
import type { VaultTask } from "./lib/types";

/**
 * Every task line of the source files, kept current through the metadata cache.
 *
 * The cache, not a regex over the file: it already knows which checkbox lines are tasks and which
 * sit inside a code block. Changes by Claude, LiveSync or the editor all arrive as `changed`.
 */
export class TaskIndex {
  private readonly byPath = new Map<string, VaultTask[]>();
  /** Bumped by every `changed` event, so a slower read started earlier cannot overwrite it. */
  private readonly versions = new Map<string, number>();
  /** Source files whose metadata the cache has not delivered yet. */
  private readonly awaiting = new Set<string>();
  private built = false;
  private resolvedOnce = false;

  constructor(
    private readonly app: App,
    private readonly changed: () => void,
  ) {}

  /**
   * Complete once every source file has been read — before that, "Task not found" or
   * "No open tasks" would be guesses about files the cache simply has not delivered.
   */
  get complete(): boolean {
    return this.built && (this.resolvedOnce || this.awaiting.size === 0);
  }

  start(plugin: Plugin): void {
    this.app.workspace.onLayoutReady(() => void this.rebuild());
    plugin.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => this.update(file, data, cache)));
    plugin.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (this.resolvedOnce) return;
        this.resolvedOnce = true;
        void this.rebuild();
      }),
    );
    plugin.registerEvent(
      this.app.vault.on("delete", (file) => {
        const removed = this.byPath.delete(file.path);
        this.awaiting.delete(file.path);
        if (removed) this.changed();
      }),
    );
    plugin.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.byPath.delete(oldPath);
        this.awaiting.delete(oldPath);
        if (file instanceof TFile) void this.indexFile(file).then(() => this.changed());
        else this.changed();
      }),
    );
  }

  get tasks(): VaultTask[] {
    return [...this.byPath.values()].flat();
  }

  /** Every task line per block id, done ones included. More than one entry is a conflict. */
  blockIndex(): Map<string, VaultTask[]> {
    const result = new Map<string, VaultTask[]>();
    for (const task of this.tasks) {
      if (task.blockId === null) continue;
      const list = result.get(task.blockId) ?? [];
      list.push(task);
      result.set(task.blockId, list);
    }
    return result;
  }

  /** The current index entry for a dragged card — by block id when it has one, else by exact text. */
  find(path: string, raw: string, blockId: string | null): VaultTask | null {
    if (blockId !== null) {
      const hits = this.blockIndex().get(blockId);
      return hits !== undefined && hits.length === 1 ? hits[0] : null;
    }
    const hits = (this.byPath.get(path) ?? []).filter((task) => task.raw === raw);
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * Entries are replaced in place, never cleared first: a second rebuild (on `resolved`) must not
   * show an empty list, or blocks as "Task not found", while it runs.
   */
  private async rebuild(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => taskSource(file.path) !== null);
    const current = new Set(files.map((file) => file.path));
    for (const path of [...this.byPath.keys()]) {
      if (!current.has(path)) this.byPath.delete(path);
    }
    for (const path of [...this.awaiting]) {
      if (!current.has(path)) this.awaiting.delete(path);
    }
    await Promise.all(files.map((file) => this.indexFile(file)));
    this.built = true;
    this.changed();
  }

  private async indexFile(file: TFile): Promise<void> {
    if (taskSource(file.path) === null) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache === null) {
      // Freshly synced and not parsed yet: its `changed` event delivers it.
      this.awaiting.add(file.path);
      return;
    }
    const version = this.versions.get(file.path) ?? 0;
    const text = await this.app.vault.cachedRead(file);
    // A `changed` event arrived while reading: its text and cache are newer than this pair.
    if ((this.versions.get(file.path) ?? 0) !== version) return;
    this.store(file.path, text, cache);
  }

  private update(file: TFile, data: string, cache: CachedMetadata): void {
    if (taskSource(file.path) === null) return;
    this.versions.set(file.path, (this.versions.get(file.path) ?? 0) + 1);
    // Text and cache from the SAME event. Read separately, they can come from two versions of a
    // file Claude just rewrote, and the line numbers would point at the wrong lines.
    this.store(file.path, data, cache);
    this.changed();
  }

  private store(path: string, text: string, cache: CachedMetadata): void {
    const lines = (cache.listItems ?? [])
      .filter((item) => item.task !== undefined)
      .map((item) => item.position.start.line);
    this.byPath.set(path, parseFileTasks(path, text, lines));
    this.awaiting.delete(path);
  }
}

/**
 * Save any editor showing this file first. Otherwise `vault.process` edits the version on disk,
 * and the editor's pending save — or its reload — throws away one of the two changes.
 */
export async function flushEditors(app: App, path: string): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) await view.save();
  }
}

function fileOf(app: App, task: VaultTask): TFile {
  const file = app.vault.getFileByPath(task.path);
  if (file === null) throw new LineChangedError();
  return file;
}

/**
 * Vault write #1: make sure the task line ends in a block id, and return it. A line that already
 * has one is not written at all.
 */
export async function writeBlockId(app: App, task: VaultTask, isTaken: (id: string) => boolean): Promise<string> {
  if (task.blockId !== null) return task.blockId;
  const file = fileOf(app, task);
  await flushEditors(app, task.path);

  const result: { blockId: string | null } = { blockId: null };
  await app.vault.process(file, (text) => {
    // By text, never by line number: Claude may have added lines above in the meantime.
    const span = locateLine(text, { raw: task.raw });
    if (typeof span === "string") throw new LineChangedError();
    const ensured = ensureBlockId(text.slice(span.start, span.end), () => newBlockId(isTaken));
    result.blockId = ensured.blockId;
    return ensured.changed ? replaceLine(text, span, ensured.line) : text;
  });
  if (result.blockId === null) throw new LineChangedError();
  return result.blockId;
}

interface TasksApi {
  executeToggleTaskDoneCommand(line: string, path: string): string;
}

/** The Tasks plugin's public API. `app.plugins` is not in the typings, so narrow from unknown. */
function tasksApi(app: App): TasksApi | null {
  const registry: unknown = (app as unknown as { plugins?: { plugins?: unknown } }).plugins?.plugins;
  if (typeof registry !== "object" || registry === null) return null;
  const tasks: unknown = (registry as Record<string, unknown>)["obsidian-tasks-plugin"];
  if (typeof tasks !== "object" || tasks === null) return null;
  const api: unknown = (tasks as { apiV1?: unknown }).apiV1;
  if (typeof api !== "object" || api === null) return null;
  const toggle: unknown = (api as { executeToggleTaskDoneCommand?: unknown }).executeToggleTaskDoneCommand;
  if (typeof toggle !== "function") return null;
  return {
    executeToggleTaskDoneCommand: (line, path) => String((toggle as (l: string, p: string) => unknown).call(api, line, path)),
  };
}

/**
 * Vault write #2: complete a task through the Tasks API, which only RETURNS the new text (two
 * lines for a recurring task). That text replaces exactly the target line; the indented lines
 * below it stay where they are.
 */
export async function toggleDone(app: App, task: VaultTask): Promise<void> {
  const api = tasksApi(app);
  if (api === null) throw new TasksMissingError();
  const file = fileOf(app, task);
  await flushEditors(app, task.path);

  await app.vault.process(file, (text) => {
    const span = locateLine(text, task.blockId !== null ? { blockId: task.blockId } : { raw: task.raw });
    if (typeof span === "string") throw new LineChangedError();
    const line = text.slice(span.start, span.end);
    // Found by block id, the line may already have been ticked in the editor a moment ago; the
    // toggle would then REOPEN it (and a recurring task would exist twice).
    if (!isOpen({ status: parseTaskLine(line, "")?.status ?? "" })) throw new LineChangedError();
    const output = api.executeToggleTaskDoneCommand(line, task.path).replace(/\n$/, "");
    if (output === "") throw new EmptyToggleError();
    if (output === line) throw new Error("Tasks did not change the line.");
    return replaceLine(text, span, output);
  });
}
