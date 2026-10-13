import { describe, expect, it } from "vitest";
import { preselect, targetName, taskTargets } from "./newTask";

const PATHS = [
  "00_Inbox/capture.md",
  "Home.md",
  "10_Kunden/Zeta/Plan.md",
  "10_Kunden/Ärzte/_infos.md",
  "10_Kunden/Ärzte/Rollout.md",
  "10_Kunden/Ärzte/Audit/Meetings/Kickoff.md",
  "10_Kunden/Ärzte/Audit/Audit.md",
  "10_Kunden/Loose.md",
  "20_Intern/Sales/Elevator Pitch.md",
  "20_Intern/Tooling/Tooling.md",
  "30_Privat/Garden.md",
];
const FOLDERS = { customerFolder: "10_Kunden", ownFolder: "20_Intern" };

describe("taskTargets", () => {
  const customers = taskTargets(PATHS, FOLDERS);

  it("lists the customer folder's subfolders and the own folder, sorted the German way", () => {
    expect(customers.map((entry) => entry.customer)).toEqual(["Ärzte", "Intern", "Zeta"]);
  });

  it("names a note by its path below the customer folder, the customer's own note first", () => {
    expect(customers[0].targets).toEqual([
      { path: "10_Kunden/Ärzte/_infos.md", label: "_infos" },
      { path: "10_Kunden/Ärzte/Audit/Audit.md", label: "Audit/Audit" },
      { path: "10_Kunden/Ärzte/Audit/Meetings/Kickoff.md", label: "Audit/Meetings/Kickoff" },
      { path: "10_Kunden/Ärzte/Rollout.md", label: "Rollout" },
    ]);
    expect(customers[1].targets.map((target) => target.label)).toEqual(["Sales/Elevator Pitch", "Tooling/Tooling"]);
  });

  it("treats the old folder note as the customer's own note too, but only directly in the folder", () => {
    const [entry] = taskTargets(["10_Kunden/Beta/Zulu.md", "10_Kunden/Beta/Beta.md", "10_Kunden/Beta/Portal/_infos.md"], FOLDERS);
    expect(entry.targets.map((target) => target.label)).toEqual(["Beta", "Portal/_infos", "Zulu"]);
    expect(taskTargets(["20_Intern/Sales/_infos.md"], FOLDERS)[0].targets[0].label).toBe("Sales/_infos");
  });

  it("never gives two notes the same name, the old and the new customer note side by side", () => {
    const [entry] = taskTargets(["10_Kunden/Acme/Plan.md", "10_Kunden/Acme/Acme.md", "10_Kunden/Acme/_infos.md"], FOLDERS);
    expect(entry.targets.slice(0, 2).map((target) => target.label).sort()).toEqual(["Acme", "_infos"]);
    expect(entry.targets[2].label).toBe("Plan");
  });

  it("follows nested folders, a digit prefix dropped, whole folder names only", () => {
    const paths = [
      "10_Company/Customers/03_Contoso/Projects/Plan.md",
      "10_Company/Customers/03_Contoso/_infos.md",
      "10_Company/Customers/_overview.md",
      "10_Company/Customers2/Fabrikam/Plan.md",
      "10_Company/Internal/Tools.md",
    ];
    expect(taskTargets(paths, { customerFolder: "10_Company/Customers", ownFolder: "10_Company/Internal" })).toEqual([
      {
        customer: "Contoso",
        targets: [
          { path: "10_Company/Customers/03_Contoso/_infos.md", label: "_infos" },
          { path: "10_Company/Customers/03_Contoso/Projects/Plan.md", label: "Projects/Plan" },
        ],
      },
      { customer: "Internal", targets: [{ path: "10_Company/Internal/Tools.md", label: "Tools" }] },
    ]);
  });

  it("offers no customer while no folder is set", () => {
    expect(taskTargets(PATHS, { customerFolder: null, ownFolder: null })).toEqual([]);
  });
});

describe("targetName", () => {
  it("names the note as the dropdown did, for the notice", () => {
    const customers = taskTargets(PATHS, FOLDERS);
    expect(targetName(customers, "10_Kunden/Ärzte/Audit/Meetings/Kickoff.md")).toBe("Ärzte · Audit/Meetings/Kickoff");
    expect(targetName(customers, "10_Kunden/Ärzte/_infos.md")).toBe("Ärzte · _infos");
  });
});

describe("preselect", () => {
  const customers = taskTargets(PATHS, FOLDERS);
  const last = "10_Kunden/Ärzte/Rollout.md";

  it("takes the list filter's customer, the last project only within it", () => {
    expect(preselect(customers, "Zeta", last)).toEqual({ customer: "Zeta", path: null });
    expect(preselect(customers, "Ärzte", last)).toEqual({ customer: "Ärzte", path: "10_Kunden/Ärzte/Rollout.md" });
  });

  it("falls back to the last target when the filter is no customer of the form", () => {
    expect(preselect(customers, "Planner", last)).toEqual({ customer: "Ärzte", path: "10_Kunden/Ärzte/Rollout.md" });
    expect(preselect(customers, null, last)).toEqual({ customer: "Ärzte", path: "10_Kunden/Ärzte/Rollout.md" });
  });

  it("leaves both on the placeholder the first time, and when the last note is gone", () => {
    expect(preselect(customers, null, null)).toEqual({ customer: null, path: null });
    expect(preselect(customers, null, "10_Kunden/Zeta/Gone.md")).toEqual({ customer: null, path: null });
  });
});
