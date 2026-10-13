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
import { getErrorMessage, getPersonalErrorMessage } from "./lib/errors";
import type { CustomerFolders } from "./lib/types";
import { ProbeModal } from "./probe";
import { TaskIndex } from "./vault";
import { PlannerView } from "./view";

/**
 * Public ids that must not live in git, the two switches and the customer folders. Tokens never go
 * here (data.json is in the vault).
 */
interface Settings extends CustomerFolders {
  tenantId: string;
  clientId: string;
  plannerEnabled: boolean;
  /** To Do and the private calendar together. Off reads nothing, and signs nobody out. */
  todoEnabled: boolean;
}

export type ChangeReason = "index" | "auth" | "settings" | "todo";

export default class VaultPlannerPlugin extends Plugin {
  settings: Settings = {
    tenantId: "",
    clientId: "",
    plannerEnabled: false,
    todoEnabled: false,
    customerFolder: null,
    ownFolder: null,
  };
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
        missing: "First enter the tenant id and client id in the settings.",
      }),
      { secret: SECRET_REFRESH_TOKEN, account: LOCAL_ACCOUNT_KEY },
      () => this.emit("auth"),
    );
    this.graph = new Graph(this.auth);
    this.todoAuth = new Auth(
      this.app,
      () => ({
        authority: TODO_AUTHORITY,
        // The same registration, opened to personal accounts (implementation plan M9, 2026-09-30).
        clientId: this.settings.clientId,
        scope: TODO_SCOPES,
        missing: "First enter the client id in the settings.",
      }),
      { secret: SECRET_TODO_REFRESH_TOKEN, account: LOCAL_TODO_ACCOUNT_KEY },
      () => this.emit("todo"),
    );
    this.todoGraph = new Graph(this.todoAuth);
    this.index = new TaskIndex(this.app, () => this.settings, () => this.emit("index"));
    this.index.start(this);

    this.registerView(VIEW_TYPE, (leaf) => new PlannerView(leaf, this));
    this.addRibbonIcon("calendar-check", "Open Vault Planner", () => void this.openPlanner());
    this.addCommand({ id: "open-planner", name: "Open Vault Planner", callback: () => void this.openPlanner() });

    // Registered once: a second registration of the same action throws.
    // Both accounts share the redirect: it goes to the one whose sign-in is waiting for this state.
    this.registerObsidianProtocolHandler(REDIRECT_ACTION, (params) => {
      const personal = this.todoAuth.expects(params.state);
      const auth = personal ? this.todoAuth : this.auth;
      const label = personal ? "Personal account signed in" : "Signed in";
      auth.handleRedirect(params).then(
        () => new Notice(`${label}${auth.account === null ? "" : ` as ${auth.account}`}.`),
        (error: unknown) => new Notice(personal ? getPersonalErrorMessage(error) : getErrorMessage(error)),
      );
    });
    // ponytail: the M9.0 probe command goes once its answers are in the plan.
    this.addCommand({
      id: "m9-probe",
      name: "M9.0 probe: check the personal account",
      callback: () => {
        if (!this.settings.todoEnabled || !this.todoAuth.signedIn) {
          new Notice("First switch on “To Do (personal)” and sign in the personal account.");
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
      todoEnabled: record.todoEnabled === true,
      // "" is "(none)" too: the dropdown's own value for it, so it must not come back as a folder.
      customerFolder: typeof record.customerFolder === "string" && record.customerFolder !== "" ? record.customerFolder : null,
      ownFolder: typeof record.ownFolder === "string" && record.ownFolder !== "" ? record.ownFolder : null,
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
    // A sign-in comes back through the browser: redraw, or the tab keeps saying "Not signed in".
    // Subscribed once per showing — a new subscription on every redraw would redraw forever.
    this.stopListening ??= plugin.onChange((reason) => {
      if (reason === "auth" || reason === "todo") this.display();
    });

    new Setting(containerEl)
      .setName("Tenant id")
      .setDesc("Directory (tenant) ID from the app registration in Entra.")
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
      .setName("Client id")
      .setDesc("Application (client) ID of the “Obsidian Vault Planner” registration — for the work account and the personal account.")
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
      .setName("Planner tasks")
      .setDesc(
        "Shows the Microsoft Planner tasks assigned to you in the list; completing them and moving them to " +
          "another bucket work in the plugin. Needs the Tasks.ReadWrite permission: without consent the plugin " +
          "signs out, and “Sign in” asks for it.",
      )
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.plannerEnabled).onChange(async (value) => {
          plugin.settings.plannerEnabled = value;
          await plugin.saveSettings();
          plugin.emit("settings");
        }),
      );

    this.addAccountRow(containerEl, "Microsoft account", plugin.auth);

    new Setting(containerEl).setName("Microsoft To Do (personal account)").setHeading();

    new Setting(containerEl)
      .setName("To Do (personal)")
      .setDesc(
        "Shows the tasks from your personal Microsoft To Do and your private calendar. Requires the app " +
          "registration to be open to personal accounts (README, Setup step 5). Switching it off hides both " +
          "but does not sign the personal account out.",
      )
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.todoEnabled).onChange(async (value) => {
          plugin.settings.todoEnabled = value;
          await plugin.saveSettings();
          plugin.emit("todo");
        }),
      );

    this.addAccountRow(containerEl, "Personal Microsoft account", plugin.todoAuth);

    new Setting(containerEl).setName("Customers").setHeading();
    const folders = this.app.vault
      .getAllFolders(false)
      .map((folder) => folder.path)
      .sort((a, b) => a.localeCompare(b, "de"));
    this.addFolderRow(containerEl, "customerFolder", folders, "Customer folder", "Every subfolder is a customer.");
    this.addFolderRow(containerEl, "ownFolder", folders, "Own folder", "The folder itself is one customer, e.g. your internal topics.");
  }

  hide(): void {
    this.stopListening?.();
    this.stopListening = null;
    super.hide();
  }

  /** A folder that no longer exists stays chosen, marked: a rename is not followed (M11). */
  private addFolderRow(
    containerEl: HTMLElement,
    key: keyof CustomerFolders,
    folders: readonly string[],
    name: string,
    desc: string,
  ): void {
    const { plugin } = this;
    const chosen = plugin.settings[key];
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dropdown) => {
        dropdown.addOption("", "(none)");
        if (chosen !== null && !folders.includes(chosen)) dropdown.addOption(chosen, `${chosen} (not found)`);
        for (const folder of folders) dropdown.addOption(folder, folder);
        dropdown.setValue(chosen ?? "").onChange(async (value) => {
          plugin.settings[key] = value === "" ? null : value;
          await plugin.saveSettings();
          // Labels only: not "settings", which reads the calendar, Planner and To Do again.
          plugin.index.relabel();
        });
      });
  }

  private addAccountRow(containerEl: HTMLElement, name: string, auth: Auth): void {
    const account = new Setting(containerEl)
      .setName(name)
      .setDesc(auth.signedIn ? `Signed in as ${auth.account ?? "unknown"}.` : "Not signed in.");
    if (auth.signedIn) {
      account.addButton((button) =>
        button.setButtonText("Sign out").onClick(() => {
          auth.logout();
          this.display();
        }),
      );
    } else {
      account.addButton((button) =>
        button
          .setButtonText("Sign in")
          .setCta()
          .onClick(() => {
            auth.login().catch((error: unknown) =>
              new Notice(auth === this.plugin.todoAuth ? getPersonalErrorMessage(error) : getErrorMessage(error)),
            );
          }),
      );
    }
  }
}
