import { getMetadataForView } from "../../app-ui/viewRoutes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("news");

export default function NewsPage() {
	return <ClientApp initialView="news" />;
}
