import { registerSlot } from "../../routes/events/slots";
import { RosterLinkPanel } from "./roster-link";

// Imported once from src/app/routes/events/routes.tsx, which the route registry loads eagerly.
registerSlot("OrganizerToolsSlot", RosterLinkPanel);
