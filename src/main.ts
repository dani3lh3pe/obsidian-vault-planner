import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { Auth } from "./auth";
import { REDIRECT_ACTION, VIEW_TYPE } from "./config";
import { Graph } from "./graph";
import { getErrorMessage } from "./lib/errors";
import { TaskIndex } from "./vault";
import { PlannerView } from "./view";

/**
 * Public ids that must not live in git, and the Planner switch. Tokens never go here (data.json is
 * in the vault).
 */
interface Settings {
  tenantId: string;
  clientId: string;
  plannerEnabled: boolean;
}

export type ChangeReason = "index" | "auth" | "settings";

export default class VaultPlannerPlugin extends Plugin {
  settings: Settings = { tenantId: "", clientId: "", plannerEnabled: false };
  auth!: Auth;
  graph!: Graph;
  index!: TaskIndex;
  private readonly listeners = new Set<(reason: ChangeReason) => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.auth = new Auth(this.app, () => this.settings, () => this.emit("auth"));
    this.graph = new Graph(this.auth);
    this.index = new TaskIndex(this.app, () => this.emit("index"));
    this.index.start(this);

    this.registerView(VIEW_TYPE, (leaf) => new PlannerView(leaf, this));
    this.addRibbonIcon("calendar-check", "Planner öffnen", () => void this.openPlanner());
    this.addCommand({ id: "open-planner", name: "Planner öffnen", callback: () => void this.openPlanner() });

    // Registered once: a second registration of the same action throws.
    this.registerObsidianProtocolHandler(REDIRECT_ACTION, (params) => {
      this.auth.handleRedirect(params).then(
        () => new Notice(`Angemeldet${this.auth.account === null ? "" : ` als ${this.auth.account}`}.`),
        (error: unknown) => new Notice(getErrorMessage(error)),
      );
    });
    this.addSettingTab(new VaultPlannerSettingTab(this.app, this));
  }

  onChange(listener: (reason: ChangeReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason: ChangeReason): void {
    for (const listener of this.listeners) listener(reason);
  }

  async openPlanner(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing !== undefined) {
      // A restored tab may be deferred; revealLeaf loads it.
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  private async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    this.settings = {
      tenantId: typeof record.tenantId === "string" ? record.tenantId : "",
      clientId: typeof record.clientId === "string" ? record.clientId : "",
      plannerEnabled: record.plannerEnabled === true,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class VaultPlannerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultPlannerPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Tenant-ID")
      .setDesc("Verzeichnis-ID (Mandanten-ID) aus der App-Registrierung in Entra.")
      .addText((text) =>
        text
          .setPlaceholder("00000000-0000-0000-0000-000000000000")
          .setValue(plugin.settings.tenantId)
          .onChange(async (value) => {
            plugin.settings.tenantId = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Client-ID")
      .setDesc("Anwendungs-ID der Registrierung „Obsidian Vault Planner“.")
      .addText((text) =>
        text
          .setPlaceholder("00000000-0000-0000-0000-000000000000")
          .setValue(plugin.settings.clientId)
          .onChange(async (value) => {
            plugin.settings.clientId = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Planner-Aufgaben")
      .setDesc(
        "Zeigt die dir zugewiesenen Aufgaben aus Microsoft Planner in der Liste; abhaken und Bucket wechseln " +
          "gehen im Plugin. Braucht die Berechtigung Tasks.ReadWrite: Fehlt die Zustimmung, meldet sich das " +
          "Plugin ab, und „Anmelden“ holt sie ein.",
      )
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.plannerEnabled).onChange(async (value) => {
          plugin.settings.plannerEnabled = value;
          await plugin.saveSettings();
          plugin.emit("settings");
        }),
      );

    const { auth } = plugin;
    const account = new Setting(containerEl)
      .setName("Microsoft-Konto")
      .setDesc(auth.signedIn ? `Angemeldet als ${auth.account ?? "unbekannt"}.` : "Nicht angemeldet.");
    if (auth.signedIn) {
      account.addButton((button) =>
        button.setButtonText("Abmelden").onClick(() => {
          auth.logout();
          this.display();
        }),
      );
    } else {
      account.addButton((button) =>
        button
          .setButtonText("Anmelden")
          .setCta()
          .onClick(() => {
            auth.login().catch((error: unknown) => new Notice(getErrorMessage(error)));
          }),
      );
    }
  }
}
