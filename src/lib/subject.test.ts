import { describe, expect, it } from "vitest";
import { cleanTitle, eventBody, eventSubject, todoEventBody } from "./subject";

describe("cleanTitle", () => {
  it("drops a parenthesised source link and the effort field", () => {
    expect(cleanTitle("Send feedback [aufwand:: 2h] ([[2026-09-24_101200_capture]])")).toBe("Send feedback");
  });

  it("keeps link text inside a sentence", () => {
    expect(cleanTitle("Talk to [[People/Max Muster|Max]] about [[ADR list#Status]] today")).toBe("Talk to Max about ADR list today");
    expect(cleanTitle("See [docs](https://example.org) and ![[image.png]]")).toBe("See docs and");
  });

  it("drops the WAITING marker", () => {
    expect(cleanTitle("WAITING Erika: clarify backup")).toBe("Erika: clarify backup");
    expect(cleanTitle("WAITING: Erika")).toBe("Erika");
  });
});

describe("eventSubject", () => {
  it("strips tags and keeps umlauts", () => {
    expect(eventSubject("Call Jürgen #customer/x [aufwand:: 1h]")).toBe("Call Jürgen");
  });

  it("never sends an empty subject", () => {
    expect(eventSubject("([[capture]])")).toBe("Focus block");
  });

  it("cuts at 255 characters", () => {
    const subject = eventSubject("a".repeat(300));
    expect(Array.from(subject)).toHaveLength(255);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("eventBody", () => {
  it("names customer, project and a link back", () => {
    expect(eventBody({ path: "10_Kunden/K/P/P.md", customer: "K", project: "P" }, "Vault")).toBe(
      "Focus block from Obsidian\nCustomer: K\nProject: P\nobsidian://open?vault=Vault&file=10_Kunden%2FK%2FP%2FP.md",
    );
  });

  it("leaves out a missing project", () => {
    expect(eventBody({ path: "10_Kunden/K/K.md", customer: "K", project: null }, "Vault")).not.toContain("Project:");
  });
});

describe("todoEventBody (M9)", () => {
  it("names the list and links the task, for the phone without Obsidian", () => {
    expect(todoEventBody({ project: "Personal" }, "https://to-do.live.com/tasks/id/T/details")).toBe(
      "Focus block from Obsidian\nTo Do: Personal\nhttps://to-do.live.com/tasks/id/T/details",
    );
  });
});
