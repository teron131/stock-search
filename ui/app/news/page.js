import { getMetadataForView } from "../../app-ui/shell/routes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("news");

export default function NewsPage() {
  return <ClientApp initialView="news" />;
}
