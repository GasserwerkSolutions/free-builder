import { getTeamReadinessIssues, validateWeeklySchedule, type BuilderDraftV2, type TeamReadinessIssue } from "./domain.js";
import { fieldPresence } from "./draft-mutations.js";
import type { PreviewTarget } from "./preview-contract.js";

// What is still missing, sorted by how much it hurts — and every entry is a jump target.
//
// Two decisions carry this module:
//
//   1. "Filled in" is not the same as "usable". The judgement comes from the three-valued
//      ContentPresence of the mutation layer (empty | present | invalid), so a typed-but-unusable
//      e-mail address is reported as a warning here without any second implementation of that rule.
//   2. Every result names a PreviewTarget, so the publish list uses exactly the navigation the
//      preview already uses. A result that could not name a field would be a dead end, so the type
//      does not allow one — the widest a rule may point is the panel that owns the problem.
//
// Requirement codes are NOT redefined here. The team rule reads TeamReadinessIssue.code, which is the
// versioned server contract, and only adds a headline and a jump target to each one.

export type ReadinessSeverity = "error" | "warning";

export type ReadinessResult = {
  id: string;
  severity: ReadinessSeverity;
  title: string;
  detail: string;
  target: PreviewTarget;
  order: number;
};

export type ReadinessSummary = {
  results: readonly ReadinessResult[];
  errorCount: number;
  warningCount: number;
  /** No blockers left. */
  ready: boolean;
  /** No blockers and no hints left. */
  clean: boolean;
};

type ReadinessRule = { id: string; evaluate(draft: Readonly<BuilderDraftV2>): readonly ReadinessResult[] };

const SERVICES_PANEL: PreviewTarget = { kind: "panel", panel: "services" };
const HOURS_PANEL: PreviewTarget = { kind: "panel", panel: "hours" };
const TEAM_PANEL: PreviewTarget = { kind: "panel", panel: "team" };

// Headlines for the codes of the activation contract. Read-only: this table never renames a code,
// never drops one and never moves its meaning — a new code simply needs a line here.
const TEAM_ISSUE_TITLES: Record<TeamReadinessIssue["code"], string> = {
  NO_ACTIVE_STAFF: "Keine aktive Person im Team",
  STAFF_WITHOUT_NAME: "Aktive Person ohne Namen",
  STAFF_WITHOUT_SERVICE: "Person ohne buchbare Leistung",
  STAFF_WITHOUT_HOURS: "Person ohne gültige Arbeitszeiten",
  SERVICE_WITHOUT_STAFF: "Buchbare Leistung ohne Person",
};

const RULES: readonly ReadinessRule[] = [
  {
    id: "identity",
    evaluate(draft) {
      if (fieldPresence(draft, "salon.name") === "present") return [];
      return [result("identity:salon-name", "error", "Salonname fehlt", "Ohne Namen hat die Website keinen Titel und kein Buchungskonto kann daran anknüpfen.", { kind: "field", field: "salon.name" }, 10)];
    },
  },
  {
    id: "contact",
    evaluate(draft) {
      const results: ReadinessResult[] = [];
      const phone = fieldPresence(draft, "salon.phone");
      const email = fieldPresence(draft, "salon.email");
      const instagram = fieldPresence(draft, "salon.instagram");
      if (phone !== "present" && email !== "present") {
        // Point at whichever field the user already started, so the jump lands where the work is.
        const target: PreviewTarget = phone === "invalid" || email === "empty" ? { kind: "field", field: "salon.phone" } : { kind: "field", field: "salon.email" };
        results.push(result("contact:none", "error", "Keine gültige Kontaktmöglichkeit", "Hinterlege eine gültige Telefonnummer oder E-Mail-Adresse, damit Kundinnen und Kunden dich erreichen.", target, 20));
      }
      if (phone === "invalid") results.push(result("contact:phone", "warning", "Telefonnummer ist unbrauchbar", "Die Nummer braucht 6 bis 15 Ziffern und wird erst dann als Anrufknopf ausgegeben.", { kind: "field", field: "salon.phone" }, 21));
      if (email === "invalid") results.push(result("contact:email", "warning", "E-Mail-Adresse ist unbrauchbar", "Die Adresse wird erst als Kontaktlink ausgegeben, wenn ihr Format gültig ist.", { kind: "field", field: "salon.email" }, 22));
      if (instagram === "invalid") results.push(result("contact:instagram", "warning", "Instagram-Adresse ist unbrauchbar", "Verwende eine vollständige Adresse auf instagram.com, sonst bleibt der Link weg.", { kind: "field", field: "salon.instagram" }, 23));
      return results;
    },
  },
  {
    id: "copy",
    evaluate(draft) {
      const results: ReadinessResult[] = [];
      const title = draft.copy.heroTitle.trim();
      if (fieldPresence(draft, "copy.heroTitle") !== "present") results.push(result("copy:hero-title", "error", "Haupttitel fehlt", "Der erste Satz der Website entscheidet, ob jemand weiterliest.", { kind: "field", field: "copy.heroTitle" }, 30));
      else if (title.length > 85) results.push(result("copy:hero-title-long", "warning", "Haupttitel ist sehr lang", `Der Titel umfasst ${title.length} Zeichen und bricht auf dem Handy stark um.`, { kind: "field", field: "copy.heroTitle" }, 31));
      if (fieldPresence(draft, "copy.heroSubtitle") !== "present") results.push(result("copy:hero-subtitle", "warning", "Einleitung fehlt", "Ein bis zwei Sätze unter dem Titel erklären, was deinen Salon ausmacht.", { kind: "field", field: "copy.heroSubtitle" }, 32));
      return results;
    },
  },
  {
    id: "services",
    evaluate(draft) {
      const results: ReadinessResult[] = [];
      if (!draft.services.length) {
        return [result("services:none", "error", "Keine Leistung erfasst", "Die Preisliste ist die Grundlage der Website und später des Buchungssystems.", SERVICES_PANEL, 40)];
      }
      if (!draft.services.some((service) => service.name.trim() && (service.price > 0 || service.priceType === "on-request"))) {
        results.push(result("services:no-priced", "error", "Keine Leistung mit Preis", "Mindestens eine Leistung braucht einen Namen und einen Preis — oder ausdrücklich „Auf Anfrage“.", SERVICES_PANEL, 40));
      }
      draft.services.forEach((service) => {
        const target: PreviewTarget = { kind: "service", serviceClientId: service.clientId, field: "name" };
        if (!service.name.trim()) {
          results.push(result(`services:${service.clientId}:name`, "error", "Leistung ohne Namen", "Eine namenlose Leistung erscheint weder auf der Website noch in der Buchung.", target, 41));
          return;
        }
        if (service.priceType !== "on-request" && service.price <= 0) {
          results.push(result(`services:${service.clientId}:price`, "warning", `„${service.name.trim()}“ hat keinen Preis`, "Trage einen Preis ein oder stelle die Leistung auf „Auf Anfrage“.", target, 42));
        }
      });
      duplicateNames(draft.services.map((service) => ({ clientId: service.clientId, value: service.name })))
        .forEach(({ clientId, label }) => results.push(result(`services:${clientId}:duplicate`, "warning", "Leistungsname ist doppelt", `„${label}“ kommt mehrfach vor — für Gäste sind die beiden Einträge nicht unterscheidbar.`, { kind: "service", serviceClientId: clientId, field: "name" }, 43)));
      return results;
    },
  },
  {
    id: "hours",
    evaluate(draft) {
      const results: ReadinessResult[] = [];
      if (!draft.businessHours.some((day) => !day.closed)) {
        results.push(result("hours:all-closed", "error", "Alle Tage sind geschlossen", "Ohne einen einzigen offenen Tag kann später kein Termin vergeben werden.", HOURS_PANEL, 50));
      }
      validateWeeklySchedule(draft.businessHours).forEach((message, index) => {
        results.push(result(`hours:invalid:${index}`, "error", "Öffnungszeiten sind ungültig", message, HOURS_PANEL, 51));
      });
      return results;
    },
  },
  {
    id: "team",
    evaluate(draft) {
      return getTeamReadinessIssues(draft as BuilderDraftV2).map((issue, index) => result(
        `team:${issue.code}:${issue.staffClientId ?? issue.serviceClientId ?? index}`,
        "error",
        TEAM_ISSUE_TITLES[issue.code],
        issue.message,
        issue.staffClientId ? { kind: "staff", staffClientId: issue.staffClientId, field: "name" } : TEAM_PANEL,
        // The order the domain reports them in is the useful one: everything about one person stays
        // together. An alphabetical tiebreaker would tear those groups apart.
        60 + index,
      ));
    },
  },
];

export function evaluateReadiness(draft: Readonly<BuilderDraftV2>): ReadinessSummary {
  const results = RULES.flatMap((rule) => rule.evaluate(draft)).sort(compareResults);
  const errorCount = results.filter((item) => item.severity === "error").length;
  const warningCount = results.length - errorCount;
  return { results, errorCount, warningCount, ready: errorCount === 0, clean: results.length === 0 };
}

function result(id: string, severity: ReadinessSeverity, title: string, detail: string, target: PreviewTarget, order: number): ReadinessResult {
  return { id, severity, title, detail, target, order };
}

function compareResults(left: ReadinessResult, right: ReadinessResult): number {
  if (left.severity !== right.severity) return left.severity === "error" ? -1 : 1;
  return left.order - right.order || left.id.localeCompare(right.id, "de-CH");
}

// Every member of a duplicate group is reported, because none of them is "the wrong one".
function duplicateNames(values: readonly { clientId: string; value: string }[]): readonly { clientId: string; label: string }[] {
  const groups = new Map<string, { label: string; clientIds: string[] }>();
  for (const item of values) {
    const key = item.value.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-CH");
    if (!key) continue;
    const group = groups.get(key) ?? { label: item.value.trim(), clientIds: [] };
    group.clientIds.push(item.clientId);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.clientIds.length > 1)
    .flatMap((group) => group.clientIds.map((clientId) => ({ clientId, label: group.label })));
}
