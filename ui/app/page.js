import { ClientApp } from "./client-app.js";

export const metadata = {
	title: "Dashboard - Stock Search",
};

export default function Page() {
	return <ClientApp initialView="dashboard" />;
}
