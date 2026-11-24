import { registerSlot } from "../../routes/events/slots";
import { RsvpPanel } from "./RsvpPanel";

// Imported once from src/app/routes/events/routes.tsx, which the route registry loads eagerly.
registerSlot("RsvpSlot", RsvpPanel);
