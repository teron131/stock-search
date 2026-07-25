import { getMetadataForView } from "../../app-ui/shell/routes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("dashboard");

export default function DashboardPage() {
  return <ClientApp initialView="dashboard" />;
}
