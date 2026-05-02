import { getMetadataForView } from "../app-ui/viewRoutes.js";
import { ClientApp } from "./client-app.js";

export const metadata = getMetadataForView("dashboard");

export default function Page() {
	return <ClientApp initialView="dashboard" />;
}
