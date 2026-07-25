import { getMetadataForView } from "../../app-ui/shell/routes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("sectors");

export default function SectorsPage() {
  return <ClientApp initialView="sectors" />;
}
