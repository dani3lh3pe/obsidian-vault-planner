import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { Auth } from "./auth";
import {
  LOCAL_ACCOUNT_KEY,
  LOCAL_TODO_ACCOUNT_KEY,
  REDIRECT_ACTION,
  scopes,
  SECRET_REFRESH_TOKEN,
  SECRET_TODO_REFRESH_TOKEN,
  TODO_AUTHORITY,
  TODO_SCOPES,
  VIEW_TYPE,
} from "./config";
import { Graph } from "./graph";
import { getErrorMessage } from "./lib/errors";
import { ProbeModal } from "./probe";
import { TaskIndex } from "./vault";
import { PlannerView } from "./view";

/**
 * Public ids that must not live in git, and the two switches. Tokens never go here (data.json is
 * in the vault).
 */
interface Settings {
  tenantId: string;
  clientId: string;
  plannerEnabled: boolean;
  /** The personal account's own app registration (M9). */
  todoClientId: string;
  /** To Do and the private calendar together. Off reads nothing, and signs nobody out. */
  todoEnabled: boolean;
}

export type ChangeReason = "index" | "auth" | "settings" | "todo";

export default class VaultPlannerPlugin extends Plugin {
  settings: Settings = { tenantId: "", clientId: "", plannerEnabled: false, todoClientId: "", todoEnabled: false };
  auth!: Auth;
  graph!: Graph;
  /** The personal Microsoft account (M9): its own sign-in, its own token, its own Graph client. */
  todoAuth!: Auth;
  todoGraph!: Graph;
  index!: TaskIndex;
  private readonly listeners = new Set<(reason: ChangeReason) => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.auth = new Auth(
      this.app,
      () => ({
        authority: this.settings.tenantId,
        clientId: this.settings.clientId,
        scope: scopes(this.settings.plannerEnabled),
        missing: "Zuerst Tenant-ID und Client-ID in den Einstellungen eintragen.",
      }),
      { secret: SECRET_REFRESH_TOKEN, account: LOCAL_ACCOUNT_KEY },
      () => this.emit("auth"),
    );
    this.graph = new Graph(this.auth);
    this.todoAuth = new Auth(
      this.app,
      () => ({
        authority: TODO_AUTHORITY,
        clientId: this.settings.todoClientId,
        scope: TODO_SCOPES,
        missing: "Zuerst die Client-ID für das private Konto in den Einstellungen eintragen.",
      }),
      { secret: SECRET_TODO_REFRESH_TOKEN, account: LOCAL_TODO_ACCOUNT_KEY },
      () => this.emit("todo"),
    );
    this.todoGraph = new Graph(this.todoAuth);
    this.index = new TaskIndex(this.app, () => this.emit("index"));
    this.index.start(this);

    this.registerView(VIEW_TYPE, (leaf) => new PlannerView(leaf, this));
    this.addRibbonIcon("calendar-check", "Planner öffnen", () => void this.openPlanner());
    this.addCommand({ id: "open-planner", name: "Planner öffnen", callback: () => void this.openPlanner() });

    // Registered once: a second registration of the same action throws.
    // Both accounts share the redirect: it goes to the one whose sign-in is waiting for this state.
    this.registerObsidianProtocolHandler(REDIRECT_ACTION, (params) => {
      const personal = this.todoAuth.expects(params.state);
      const auth = personal ? this.todoAuth : this.auth;
      // ponytail: "Privates Konto:" in front of the work account's texts — own texts come with M9.1 (spec).
      const label = personal ? "Privates Konto angemeldet" : "Angemeldet";
      auth.handleRedirect(params).then(
        () => new Notice(`${label}${auth.account === null ? "" : ` als ${auth.account}`}.`),
        (error: unknown) => new Notice(personal ? `Privates Konto: ${getErrorMessage(error)}` : getErrorMessage(error)),
      );
    });
    // ponytail: the M9.0 probe command goes once its answers are in the plan.
    this.addCommand({
      id: "m9-probe",
      name: "M9.0-Probe: privates Konto prüfen",
      callback: () => {
        if (!this.settings.todoEnabled || !this.todoAuth.signedIn) {
          new Notice("Zuerst „To Do (privat)“ einschalten und das private Konto anmelden.");
          return;
        }
        new ProbeModal(this.app, this.todoGraph).open();
      },
    });
    this.addSettingTab(new VaultPlannerSettingTab(this.app, this));
  }

  onChange(listener: (reason: ChangeReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason: ChangeReason): void {
    // A copy: a listener that subscribes anew while being called must not be called again.
    for (const listener of [...this.listeners]) listener(reason);
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
      todoClientId: typeof record.todoClientId === "string" ? record.todoClientId : "",
      todoEnabled: record.todoEnabled === true,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class VaultPlannerSettingTab extends PluginSettingTab {
  /** Named apart from PluginSettingTab's own members, which obsidian.d.ts does not list in full. */
  private stopListening: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultPlannerPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();
    // A sign-in comes back through the browser: redraw, or the tab keeps saying "Nicht angemeldet".
    // Subscribed once per showing — a new subscription on every redraw would redraw forever.
    this.stopListening ??= plugin.onChange((reason) => {
      if (reason === "auth" || reason === "todo") this.display();
    });

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

    this.addAccountRow(containerEl, "Microsoft-Konto", plugin.auth);

    new Setting(containerEl).setName("Microsoft To Do (privates Konto)").setHeading();

    new Setting(containerEl)
      .setName("Client-ID (privat)")
      .setDesc("Anwendungs-ID der zweiten Registrierung „Nur private Microsoft-Konten“.")
      .addText((text) =>
        text
          .setPlaceholder("00000000-0000-0000-0000-000000000000")
          .setValue(plugin.settings.todoClientId)
          .onChange(async (value) => {
            plugin.settings.todoClientId = value.trim();
            await plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("To Do (privat)")
      .setDesc(
        "Zeigt die Aufgaben aus deinem privaten Microsoft To Do und deinen privaten Kalender. Ausschalten " +
          "blendet beides aus, meldet das private Konto aber nicht ab.",
      )
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.todoEnabled).onChange(async (value) => {
          plugin.settings.todoEnabled = value;
          await plugin.saveSettings();
          plugin.emit("todo");
        }),
      );

    this.addAccountRow(containerEl, "Privates Microsoft-Konto", plugin.todoAuth);
  }

  hide(): void {
    this.stopListening?.();
    this.stopListening = null;
    super.hide();
  }

  private addAccountRow(containerEl: HTMLElement, name: string, auth: Auth): void {
    const account = new Setting(containerEl)
      .setName(name)
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
