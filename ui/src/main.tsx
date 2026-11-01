import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SitesApp } from "./App.tsx";
import "./tailwind.css";

subscribeCompanionTheme();
const mount = document.getElementById("ryu-plugin-root");

if (mount) {
	markCompanionAppRoot(mount);
	createRoot(mount).render(
		<StrictMode>
			<RyuAppShell>
				<SitesApp />
			</RyuAppShell>
		</StrictMode>
	);
}
