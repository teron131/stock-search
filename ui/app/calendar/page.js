import { ClientApp } from "../client-app.js";

export const metadata = {
	title: "Calendar - Stock Search",
};

export default function CalendarPage() {
	return <ClientApp initialView="calendar" />;
}
