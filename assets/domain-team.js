import { createClientId, createClosedSchedule } from "./domain-model.js";
import { validateWeeklySchedule } from "./domain-normalize.js";
export function createStaffDraft() {
    return {
        clientId: createClientId("staff"),
        name: "Neue Person",
        email: "",
        role: "Coiffeur/in",
        bio: "",
        specialties: [],
        active: true,
        serviceClientIds: [],
        workingHours: createClosedSchedule(),
        portraitAssetLocalId: null,
    };
}
export function copyBusinessHoursToStaff(draft, staffClientId) {
    const staff = draft.staff.find((person) => person.clientId === staffClientId);
    if (!staff)
        return;
    staff.workingHours = structuredClone(draft.businessHours);
}
export function setAllBookableServicesForStaff(draft, staffClientId, selected) {
    const staff = draft.staff.find((person) => person.clientId === staffClientId);
    if (!staff)
        return;
    staff.serviceClientIds = selected ? draft.services.filter((service) => service.bookable).map((service) => service.clientId) : [];
}
export function setStaffService(draft, staffClientId, serviceClientId, selected) {
    const staff = draft.staff.find((person) => person.clientId === staffClientId);
    const service = draft.services.find((item) => item.clientId === serviceClientId);
    if (!staff || !service?.bookable)
        return;
    const next = new Set(staff.serviceClientIds);
    if (selected)
        next.add(serviceClientId);
    else
        next.delete(serviceClientId);
    staff.serviceClientIds = [...next];
}
export function removeStaffAndOwnedAssets(draft, staffClientId) {
    const portraitLocalId = draft.staff.find((person) => person.clientId === staffClientId)?.portraitAssetLocalId;
    const assetIds = new Set(draft.assets
        .filter((asset) => asset.ownerClientId === staffClientId || portraitLocalId === asset.localId)
        .map((asset) => asset.localId));
    draft.staff = draft.staff.filter((person) => person.clientId !== staffClientId);
    draft.assets = draft.assets.filter((asset) => !assetIds.has(asset.localId));
}
export function getTeamReadinessIssues(draft) {
    const issues = [];
    const activeStaff = draft.staff.filter((person) => person.active);
    const bookableServices = draft.services.filter((service) => service.bookable);
    if (!activeStaff.length) {
        issues.push({ code: "NO_ACTIVE_STAFF", message: "Mindestens eine aktive Person fehlt." });
        return issues;
    }
    for (const person of activeStaff) {
        const displayName = person.name.trim() || "Unbenannte Person";
        if (!person.name.trim()) {
            issues.push({ code: "STAFF_WITHOUT_NAME", staffClientId: person.clientId, message: "Eine aktive Person hat keinen Namen." });
        }
        const assignedBookableServices = person.serviceClientIds.filter((serviceClientId) => bookableServices.some((service) => service.clientId === serviceClientId));
        if (!assignedBookableServices.length) {
            issues.push({ code: "STAFF_WITHOUT_SERVICE", staffClientId: person.clientId, message: `${displayName} hat keine buchbare Leistung.` });
        }
        const openDays = person.workingHours.filter((day) => !day.closed);
        if (!openDays.length || validateWeeklySchedule(person.workingHours).length) {
            issues.push({ code: "STAFF_WITHOUT_HOURS", staffClientId: person.clientId, message: `${displayName} hat keine gültigen Arbeitszeiten.` });
        }
    }
    for (const service of bookableServices) {
        const covered = activeStaff.some((person) => person.serviceClientIds.includes(service.clientId));
        if (!covered) {
            issues.push({ code: "SERVICE_WITHOUT_STAFF", serviceClientId: service.clientId, message: `${service.name || "Eine buchbare Leistung"} ist keiner aktiven Person zugeordnet.` });
        }
    }
    return issues;
}
export function getTeamReadinessChecks(draft) {
    const issues = getTeamReadinessIssues(draft);
    return [
        { label: "Mindestens eine aktive Person", ready: !issues.some((issue) => issue.code === "NO_ACTIVE_STAFF" || issue.code === "STAFF_WITHOUT_NAME") },
        { label: "Jede aktive Person hat Leistungen und Arbeitszeiten", ready: !issues.some((issue) => issue.code === "STAFF_WITHOUT_SERVICE" || issue.code === "STAFF_WITHOUT_HOURS") },
        { label: "Jede buchbare Leistung ist personell abgedeckt", ready: !issues.some((issue) => issue.code === "SERVICE_WITHOUT_STAFF") },
    ];
}
