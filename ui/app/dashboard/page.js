import { ClientApp } from "../client-app.js";

export const metadata = {
	title: "Dashboard - Stock Search",
};

export default function DashboardPage() {
	return <ClientApp initialView="dashboard" />;
}
