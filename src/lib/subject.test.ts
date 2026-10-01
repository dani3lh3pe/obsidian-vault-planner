import { describe, expect, it } from "vitest";
import { cleanTitle, eventBody, eventSubject, todoEventBody } from "./subject";

describe("cleanTitle", () => {
  it("drops a parenthesised source link and the effort field", () => {
    expect(cleanTitle("Rückmeldung geben [aufwand:: 2h] ([[2026-09-24_101200_capture]])")).toBe("Rückmeldung geben");
  });

  it("keeps link text inside a sentence", () => {
    expect(cleanTitle("Mit [[Personen/Max Muster|Max]] über [[ADR-Liste#Stand]] reden")).toBe("Mit Max über ADR-Liste reden");
    expect(cleanTitle("Siehe [Doku](https://example.org) und ![[bild.png]]")).toBe("Siehe Doku und");
  });

  it("drops the WAITING marker", () => {
    expect(cleanTitle("WAITING Erika: Backup klären")).toBe("Erika: Backup klären");
    expect(cleanTitle("WAITING: Erika")).toBe("Erika");
  });
});

describe("eventSubject", () => {
  it("strips tags and keeps umlauts", () => {
    expect(eventSubject("Übergabe prüfen #kunde/x [aufwand:: 1h]")).toBe("Übergabe prüfen");
  });

  it("never sends an empty subject", () => {
    expect(eventSubject("([[capture]])")).toBe("Fokus-Block");
  });

  it("cuts at 255 characters", () => {
    const subject = eventSubject("a".repeat(300));
    expect(Array.from(subject)).toHaveLength(255);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("eventBody", () => {
  it("names customer, project and a link back", () => {
    expect(eventBody({ path: "10_Kunden/K/P/P.md", kunde: "K", projekt: "P" }, "Vault")).toBe(
      "Fokus-Block aus Obsidian\nKunde: K\nProjekt: P\nobsidian://open?vault=Vault&file=10_Kunden%2FK%2FP%2FP.md",
    );
  });

  it("leaves out a missing project", () => {
    expect(eventBody({ path: "10_Kunden/K/K.md", kunde: "K", projekt: null }, "Vault")).not.toContain("Projekt:");
  });
});

describe("todoEventBody (M9)", () => {
  it("names the list and links the task, for the phone without Obsidian", () => {
    expect(todoEventBody({ projekt: "Privat" }, "https://to-do.live.com/tasks/id/T/details")).toBe(
      "Fokus-Block aus Obsidian\nTo Do: Privat\nhttps://to-do.live.com/tasks/id/T/details",
    );
  });
});
