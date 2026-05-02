import { getMetadataForView } from "../../app-ui/viewRoutes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("calendar");

export default function CalendarPage() {
	return <ClientApp initialView="calendar" />;
}
