import { registerSlot } from "../../routes/events/slots";
import { EventEditPanel } from "./edit";

// Imported once from src/app/routes/events/routes.tsx, which the route registry loads eagerly.
registerSlot("OrganizerToolsSlot", EventEditPanel);
