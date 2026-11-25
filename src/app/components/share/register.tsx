import { registerSlot } from "../../routes/events/slots";
import { SharePanel } from "./SharePanel";

// Imported once from src/app/routes/events/routes.tsx, which the route registry loads eagerly.
registerSlot("ShareSlot", SharePanel);
