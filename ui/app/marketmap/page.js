import { getMetadataForView } from "../../app-ui/shell/routes.js";
import { ClientApp } from "../client-app.js";

export const metadata = getMetadataForView("marketmap");

export default function MarketMapPage() {
  return <ClientApp initialView="marketmap" />;
}
